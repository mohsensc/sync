// Package contend is the Go mirror of cpp/daemon/contend_queue.{hpp,cpp}:
// paths this agent was stopped on, waiting to be told to the relay.
//
// A PreToolUse edit is answered locally from the lease cache and produces
// no PostToolUse event, so without this the relay never learns anybody
// wanted the region and the holder's lease never gets a handover deadline.
// Decision goroutines drop a path in; the daemon's relay-forwarding loop
// drains it and sends one contend frame per drain.
package contend

import "sync"

// Max is the cap on distinct pending paths. A burst this large is a
// session touching everything, not a contest worth queueing.
const Max = 64

// Queue stays a plain mutex, not a channel-owned goroutine (#20): Note only
// fires from the decision path on the branch where a decision was already
// blocked, not on every call, and Drain runs once a tick. Off the hot path,
// guards one small slice plus a dedup map, no ordering requirement between
// callers — see docs/go-daemon.md's "every remaining mutex, checked on
// merit" section.
type Queue struct {
	mu      sync.Mutex
	pending []string
	seen    map[string]bool
}

func New() *Queue {
	return &Queue{seen: make(map[string]bool)}
}

// Note remembers a path. Safe from any goroutine. Repeats within one drain
// collapse; past Max distinct paths, the newest are dropped.
func (q *Queue) Note(path string) {
	if path == "" {
		return
	}
	q.mu.Lock()
	defer q.mu.Unlock()
	if q.seen[path] || len(q.pending) >= Max {
		return
	}
	q.seen[path] = true
	q.pending = append(q.pending, path)
}

// Drain takes everything pending. Empty when nothing was blocked.
func (q *Queue) Drain() []string {
	q.mu.Lock()
	defer q.mu.Unlock()
	out := q.pending
	q.pending = nil
	q.seen = make(map[string]bool)
	return out
}
