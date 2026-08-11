// Package leases is a read-only cache of relay-held leases, refreshed by
// push. It is the Go mirror of cpp/daemon/lease_cache.{hpp,cpp} — same
// question, same answer, no protocol logic of its own: "is there a live
// lease on this region held by somebody else?"
//
// Wave 1 scope: replace/conflict lookup only. HandoverNote (own_handover,
// handover_note) is not ported yet — see docs/go-daemon.md — so an agent
// that loses a region here gets no "lost_to" note on its next edit. That is
// a real, known behavior gap, not an oversight.
package leases

import (
	"strings"
	"sync"
)

// Lease is the Go shape of cpp/daemon/lease_cache.hpp's CachedLease.
type Lease struct {
	Agent       string
	Human       string
	Intent      string
	Priority    string
	ExpiresAtMs int64 // monotonic instant, this process's clock
	Waiting     int
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
}

func New() *Cache {
	return &Cache{byRegion: make(map[string]Lease)}
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
