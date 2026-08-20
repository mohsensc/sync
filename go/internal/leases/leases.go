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
// by uptime.
//
// decide.go sends lost_ms_ago derived from this unclamped; the hook reads it
// through int_field, which saturates at kIntFieldCeiling in cpp/hook/hook.cpp.
// That ceiling must stay comfortably above this value or old losses render
// with the wrong "ago".
const HandoverNoteMs = 30 * 60 * 1000

// Lease is the Go shape of cpp/daemon/lease_cache.hpp's CachedLease.
type Lease struct {
	Agent    string
	Human    string
	Intent   string
	Priority string
	// ExpiresAtMs is wall-clock ms (time.Now().UnixMilli()), not a monotonic
	// instant — see docs/go-daemon.md's clock-source note for the known gap
	// this leaves against a system clock step.
	ExpiresAtMs int64
	Waiting     int

	// Symbol is the scope this lease was claimed at — "" for a whole-file
	// claim, the same sentinel a nil symbol gets everywhere else in this
	// package (see symbolsConflict below).
	// It duplicates the second half of the map key it lives under
	// (RegionKey encodes "path|symbol"), because Conflict needs to read it
	// back out once a region has already been found by path alone. See
	// Conflict for why this is the one piece of symbol information that
	// ever reaches the daemon.
	Symbol string

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
// queried by the hook socket's decision handlers. Deliberately RWMutex, not
// a channel-owned goroutine (#20): Conflict is the decision hot path, many
// goroutines reading concurrently against one occasional writer, and a
// measured channel-owned prototype was 49x-86x worse at p99 under an 8/16
// lane storm because a single owner goroutine serializes what RWMutex lets
// run in parallel. See docs/go-daemon.md's "every remaining mutex, checked
// on merit" section for the numbers.
type Cache struct {
	mu       sync.RWMutex
	byRegion map[string]Lease
	lost     map[string]HandoverNote // keyed on path, not region — see NoteHandover

	// lastSweepMs is when the pruneFloor sweep last ran, so Upsert can gate
	// on sweepCooldownMs below instead of re-scanning the whole table on
	// every single write once the table is big. Zero value means "never
	// swept," which is correct: it makes the first write past the floor
	// sweep immediately rather than waiting out a cooldown against nothing.
	lastSweepMs int64
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

// pruneFloor is how big byRegion has to get before Upsert bothers sweeping
// it. A live room's region count is small — a handful of files times a
// handful of agents — so below this a sweep is pure write-lock hold time
// with nothing to collect; BenchmarkConflictConcurrentReads (#20 territory,
// Conflict runs under the same lock a sweep would hold) measured a real hit
// to reader p50 at the benchmark's 1,000-entry table with no floor. Above
// it, byRegion is no longer "a live room's leases" but "however much
// garbage backpressure-dropped departure frames left behind," which is
// exactly the unbounded growth #89 is about — worth the lock hold.
const pruneFloor = 2048

// sweepCooldownMs floors the gap between two pruneFloor sweeps. Once a busy
// room's table sits above pruneFloor for good (garbage arriving as fast as
// it's collected — the #89 case), the floor check alone degenerates into a
// full O(n) scan under the write lock on *every* Upsert: benchmarked at
// ~17.3µs/op sustained, against ~122ns/op below the floor, a 142x hit that
// lands on the same write lock Conflict's readers queue behind. The
// cooldown caps how often that scan actually runs instead of gating whether
// it ever does.
//
// This bounds staleness, not just cost: an entry that expires can sit in
// byRegion for up to sweepCooldownMs past the write that would otherwise
// have swept it — Conflict already treats an expired entry as invisible
// (see its "stale-but-harmless" comment), so this never blocks anything
// on a stale lease, it only delays reclaiming the memory. 1s is nowhere
// near LeaseTTLS's 90s default, so the delay a caller could ever observe
// in memory pressure terms is two orders of magnitude under the TTL the
// rest of the system already budgets for.
const sweepCooldownMs = 1000

// Upsert sets or renews one entry. Called for a single "lease" or
// "claim_result" frame.
//
// nowMs also drives a prune sweep once the table passes pruneFloor:
// byRegion entries otherwise only ever leave via Replace (a snapshot) or
// EraseIfHeldBy (an explicit departure frame), and departure frames are
// droppable under backpressure (WsConn.Send sheds the oldest queued frame
// once a connection falls behind) — a shed frame means nothing ever tells
// this cache the region is free. Same prune-on-write shape as NoteHandover
// uses for the lost map, gated so the common small-table case doesn't pay
// for a sweep it doesn't need, and cooled down by sweepCooldownMs so a
// table that stays above the floor doesn't pay for a sweep on every write.
func (c *Cache) Upsert(key string, l Lease, nowMs int64) {
	c.mu.Lock()
	if c.byRegion == nil {
		c.byRegion = make(map[string]Lease)
	}
	c.byRegion[key] = l
	// nowMs is wall clock (time.Now().UnixMilli()), not monotonic, so a
	// backwards NTP step makes nowMs-c.lastSweepMs negative — the cooldown
	// gate would then never fire for the rest of that window, reopening the
	// #89 unbounded-growth shape it exists to close. Treat a clock that's
	// gone backwards as an elapsed cooldown rather than an unmet one.
	if len(c.byRegion) > pruneFloor && (nowMs < c.lastSweepMs || nowMs-c.lastSweepMs >= sweepCooldownMs) {
		for k, existing := range c.byRegion {
			if existing.ExpiresAtMs <= nowMs {
				delete(c.byRegion, k)
			}
		}
		c.lastSweepMs = nowMs
	}
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

// heldByMe answers whether agent is one of myAgents — package level, not a
// closure, because Conflict runs under the cache's RLock on the 5ms
// decision path and a closure captured per call is an allocation this hot
// path doesn't need. Empty strings never match: an unconfigured relay
// identity or a hook line with no session id both come through as "", and
// a lease is never legitimately held by nobody.
func heldByMe(agent string, myAgents []string) bool { return IsMine(agent, myAgents) }

// IsMine reports whether an agent id is one of the caller's own. Exported
// because decide asks the same question about a handover target that this
// package asks about a lease holder, and two spellings of "is that me" is
// how the namespace bug it fixes got in.
func IsMine(agent string, myAgents []string) bool {
	if agent == "" {
		return false
	}
	for _, a := range myAgents {
		if a != "" && a == agent {
			return true
		}
	}
	return false
}

// Conflict is the whole-file question a hook decision asks, extended to
// tell a same-symbol conflict (rung 3) from a disjoint-symbol one (rung 2):
// is there a live lease anywhere under this path, held by somebody other
// than myAgents, and if so, does it actually overlap what myAgents is known
// to be touching?
//
// myAgents is a set, not a single id, because a lease can be held under
// either of two different namespaces for the same requester: the daemon's
// own relay identity, and the hook session's id (the MCP surface claims
// under the session id; the daemon's decision path used to check only its
// own relay identity, so a session that had just claimed a region through
// MCP was denied editing it — see decide.Decide's note on the two
// namespaces, and cpp/hook/hook.hpp's handover_to_me comment for the same
// disease in a different spot). A lease held by either identity is mine.
//
// Region keys are "path|symbol", so the path match is a prefix match — a
// live claim on "path|sign_in" contends with a plain edit on "path" even
// though the hook names no symbol. See symbolsConflict below for the exact
// rule this and the relay's own classifier both implement.
//
// "What myAgents is known to be touching" is never the incoming edit
// itself — a hook-observed Edit/Write carries no symbol at all, only a
// path (cpp/hook/hook.cpp's build_event has no field for one). The only
// place symbol information about *this* agent's own work ever reaches the
// daemon is a claim one of myAgents declared through MCP's claim_work,
// which is already sitting in this same cache. So "mine" below means
// "every symbol any of myAgents currently holds a live lease on at this
// path" — evidence, not a guess.
//
// No claim of my own, or a claim on the whole file on either side, is read
// the same way same_region() reads a nil symbol: it contends with
// everything. Rung 2 only comes back when there is positive evidence of
// two distinct, non-empty symbols; anything less falls back to rung 3,
// because a rung that fires on the wrong evidence is worse than one that
// never fires — it makes the ladder lie. When several other agents hold
// leases on the path, the worse of the two rungs wins, the same way
// ladder.classify keeps the highest rung across every other activity.
func (c *Cache) Conflict(path string, myAgents []string, nowMs int64) (held Lease, rung int, ok bool) {
	prefix := path + "|"
	c.mu.RLock()
	defer c.mu.RUnlock()

	var mine []string
	for key, l := range c.byRegion {
		if !strings.HasPrefix(key, prefix) {
			continue
		}
		if !heldByMe(l.Agent, myAgents) || l.ExpiresAtMs <= nowMs {
			continue
		}
		mine = append(mine, l.Symbol)
	}

	for key, l := range c.byRegion {
		if !strings.HasPrefix(key, prefix) {
			continue
		}
		if l.Agent == "" || heldByMe(l.Agent, myAgents) {
			continue
		}
		if l.ExpiresAtMs <= nowMs {
			// Stale-but-harmless: never blocks. It doesn't remove itself —
			// nothing does, until the next Upsert's prune sweep or a fresh
			// Replace catches it; skipping it here just keeps a lookup that
			// happens to land between sweeps honest.
			continue
		}
		r := 2
		if symbolsConflict(l.Symbol, mine) {
			r = 3
		}
		if !ok || r > rung {
			held, rung, ok = l, r, true
		}
		if rung == 3 {
			break // nothing beats it
		}
	}
	return held, rung, ok
}

// symbolsConflict is same_region()'s rule, applied between one held
// symbol and every symbol the requester is known to hold on the same
// path: a held symbol of "" (the whole file) or a requester with no known
// symbol of their own conflicts with everything; two known, distinct,
// non-empty symbols do not.
func symbolsConflict(held string, mine []string) bool {
	if held == "" || len(mine) == 0 {
		return true
	}
	for _, s := range mine {
		if s == "" || s == held {
			return true
		}
	}
	return false
}

// OwnHandover is this agent's own live lease on the file, when somebody is
// waiting on it — the mirror image of Conflict: same prefix match, opposite
// agent test, and only ever answers when there is a deadline to report.
// This is how a holder finds out it is on the clock; there is no push
// channel to an agent, so the warning rides on its next edit.
// Takes the same identity set Conflict does, and for the same reason: the
// daemon's relay identity and the requesting session's id are different
// strings for one agent, so a region claimed under a session id has a
// handover deadline the daemon would otherwise never mention to the session
// it belongs to.
func (c *Cache) OwnHandover(path string, myAgents []string, nowMs int64) (Lease, bool) {
	if path == "" || len(myAgents) == 0 {
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
		if !heldByMe(l.Agent, myAgents) {
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
