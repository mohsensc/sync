// Package leases is a read-only cache of relay-held leases, refreshed by
// push. It is the Go mirror of cpp/daemon/lease_cache.{hpp,cpp} — same
// question, same answer, no protocol logic of its own: "is there a live
// lease on this region held by somebody else?"
package leases

import (
	"strings"
	"sync"
)

// HandoverNoteMs is how long a lost region stays worth mentioning — long
// enough to cover the agent noticing and coming back to the file, short
// enough that it is news rather than history. Also the horizon Cache prunes
// on, so the lost-region map is bounded by the last half hour rather than
// by uptime. Matches lease_cache.hpp's kHandoverNoteMs.
const HandoverNoteMs = 30 * 60 * 1000

// Lease is the Go shape of cpp/daemon/lease_cache.hpp's CachedLease.
type Lease struct {
	Agent       string
	Human       string
	Intent      string
	Priority    string
	ExpiresAtMs int64 // monotonic instant, this process's clock
	Waiting     int

	// When this lease stops being renewable. HasHandover false means nobody
	// has asked for the region — the common case, and one that renews
	// forever; HandoverAtMs is meaningless until it is true. A Go zero
	// value has no spare sentinel the way C++'s handover_at_ms = -1 does,
	// so the presence bit is explicit instead.
	HasHandover        bool
	HandoverAtMs       int64
	HandoverTo         string
	HandoverToHuman    string
	HandoverToPriority string
}

// HandoverNote is a region this agent used to hold and no longer does, and
// who has it now — lease_cache.hpp's HandoverNote struct.
type HandoverNote struct {
	To         string
	ToHuman    string
	ToPriority string
	AtMs       int64 // monotonic; stale notes are dropped on read
}

// RegionKey is how the cache is keyed: a path plus an optional symbol,
// joined so a whole-file region (empty symbol) and a symbol region never
// collide. Mirrors relay_client.hpp's region_key.
func RegionKey(path, symbol string) string {
	return path + "|" + symbol
}

// Cache is safe for concurrent use: replaced by the relay's read pump,
// queried by the hook socket's decision handlers.
type Cache struct {
	mu       sync.RWMutex
	byRegion map[string]Lease
	lost     map[string]HandoverNote // keyed on path, not region — see NoteHandover
}

func New() *Cache {
	return &Cache{byRegion: make(map[string]Lease), lost: make(map[string]HandoverNote)}
}

// Replace swaps the whole table. Called for a "leases" snapshot frame — join
// or relay restart — the two moments the relay states the whole truth at
// once; see relay.Client.dispatch.
func (c *Cache) Replace(entries map[string]Lease) {
	c.mu.Lock()
	c.byRegion = entries
	c.mu.Unlock()
}

// Upsert sets or renews one entry. Called for a single "lease" or
// "claim_result" frame.
func (c *Cache) Upsert(key string, l Lease) {
	c.mu.Lock()
	if c.byRegion == nil {
		c.byRegion = make(map[string]Lease)
	}
	c.byRegion[key] = l
	c.mu.Unlock()
}

// EraseIfHeldBy drops the entry at key, but only when agent is the one
// currently holding it. A region key alone does not identify what a
// released/expired/handover frame is talking about: on a handover the relay
// publishes the new holder and the old holder's expiry as two frames about
// the same region, and an unconditional erase on the key would let the
// second one delete what the first just granted. See erase_lease's comment
// in relay_client.cpp — this is the exact failure this check exists to
// prevent, ported verbatim.
func (c *Cache) EraseIfHeldBy(key, agent string) {
	if agent == "" {
		return
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	if l, ok := c.byRegion[key]; ok && l.Agent == agent {
		delete(c.byRegion, key)
	}
}

// ConflictForFile is the whole-file question a hook decision asks: is there
// a live lease anywhere under this path, held by somebody other than
// myAgent? Region keys are "path|symbol", so this matches by that prefix —
// a live claim on "path|sign_in" contends with a plain edit on "path" even
// though the hook names no symbol. See same_region() in types.py, which is
// the authority both this and the C++ cache answer to.
func (c *Cache) ConflictForFile(path, myAgent string, nowMs int64) (Lease, bool) {
	prefix := path + "|"
	c.mu.RLock()
	defer c.mu.RUnlock()
	for key, l := range c.byRegion {
		if !strings.HasPrefix(key, prefix) {
			continue
		}
		if l.Agent == "" || l.Agent == myAgent {
			continue
		}
		if l.ExpiresAtMs <= nowMs {
			continue // stale-but-harmless: never blocks, ages out on its own
		}
		return l, true
	}
	return Lease{}, false
}

// OwnHandover is this agent's own live lease on the file, when somebody is
// waiting on it — the mirror image of ConflictForFile: same prefix match,
// opposite agent test, and only ever answers when there is a deadline to
// report. This is how a holder finds out it is on the clock; there is no
// push channel to an agent, so the warning rides on its next edit.
func (c *Cache) OwnHandover(path, myAgent string, nowMs int64) (Lease, bool) {
	if path == "" || myAgent == "" {
		return Lease{}, false
	}
	prefix := path + "|"
	c.mu.RLock()
	defer c.mu.RUnlock()
	var soonest Lease
	found := false
	for key, l := range c.byRegion {
		if !strings.HasPrefix(key, prefix) {
			continue
		}
		if l.Agent != myAgent {
			continue
		}
		if l.ExpiresAtMs <= nowMs {
			continue
		}
		if !l.HasHandover {
			continue
		}
		if !found || l.HandoverAtMs < soonest.HandoverAtMs {
			soonest = l
			found = true
		}
	}
	return soonest, found
}

// NoteHandover remembers that this agent's region went to somebody else.
func (c *Cache) NoteHandover(path string, note HandoverNote) {
	if path == "" {
		return
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.lost == nil {
		c.lost = make(map[string]HandoverNote)
	}
	// Prune on write, so the map is bounded by the last half hour of
	// handovers rather than by how long the daemon has been up.
	cutoff := note.AtMs - HandoverNoteMs
	for p, n := range c.lost {
		if n.AtMs < cutoff {
			delete(c.lost, p)
		}
	}
	c.lost[path] = note
}

// HandoverNoteFor is a handover of this file recorded within withinMs, if
// any.
func (c *Cache) HandoverNoteFor(path string, nowMs, withinMs int64) (HandoverNote, bool) {
	if path == "" {
		return HandoverNote{}, false
	}
	c.mu.RLock()
	defer c.mu.RUnlock()
	n, ok := c.lost[path]
	if !ok || nowMs-n.AtMs > withinMs {
		return HandoverNote{}, false
	}
	return n, true
}
