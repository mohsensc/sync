// Package outbound is a bounded, drop-oldest FIFO for frames waiting on the
// relay. Mirrors cpp/daemon/outbound.{hpp,cpp}: presence is only useful
// while current, so a long outage discards the oldest frame first rather
// than growing without bound or replaying a flood of stale presence on
// reconnect.
package outbound

import "sync"

// Queue stays a plain mutex, not a channel-owned goroutine (#20): Push is
// called from the event path and the tick, never the decision path, and
// drop-oldest needs to inspect and trim the slice on every push — a plain
// channel send can't express "drop the oldest queued item," only "block or
// drop the newest one." See docs/go-daemon.md's "every remaining mutex,
// checked on merit" section.
type Queue struct {
	mu       sync.Mutex
	cap      int
	dropped  int
	messages [][]byte
}

func New(capacity int) *Queue {
	return &Queue{cap: capacity}
}

// Push queues a message, dropping the oldest queued one if the queue is
// already at capacity. Capacity 0 drops everything, same as the C++ side.
func (q *Queue) Push(msg []byte) {
	q.mu.Lock()
	defer q.mu.Unlock()
	if q.cap == 0 {
		q.dropped++
		return
	}
	if len(q.messages) >= q.cap {
		q.messages = q.messages[1:]
		q.dropped++
	}
	q.messages = append(q.messages, msg)
}

// Drain returns and clears everything queued.
func (q *Queue) Drain() [][]byte {
	q.mu.Lock()
	defer q.mu.Unlock()
	out := q.messages
	q.messages = nil
	return out
}

func (q *Queue) Dropped() int {
	q.mu.Lock()
	defer q.mu.Unlock()
	return q.dropped
}

func (q *Queue) Len() int {
	q.mu.Lock()
	defer q.mu.Unlock()
	return len(q.messages)
}
