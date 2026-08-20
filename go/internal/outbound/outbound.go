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

	// head is a monotonic sequence number for whatever currently sits at
	// messages[0]. It advances by one on every removal from the front —
	// Pop or drop-oldest, whichever gets there first — so Peek's caller can
	// hand its sequence back to Pop and have Pop refuse to act if that
	// exact frame already left some other way. Without this, Peek+write+Pop
	// has a gap between "write succeeded" and "Pop runs" that a concurrent
	// Push's drop-oldest can land in: it evicts the peeked frame (already
	// written, fine) and promotes the next one to the front, and a Pop with
	// no way to name what it's removing would then delete that next frame
	// instead — the one actually unwritten. See client.writePump.
	head uint64
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
		// This can evict messages[0] while writePump has it out on Peek and
		// has already written it to the relay but not yet called Pop — Pop
		// then finds head advanced past its seq and reports false, which is
		// fine (see Pop), but dropped has already counted a frame that was
		// really delivered. Narrow window, only under sustained backpressure
		// at capacity, and the alternative (holding the lock across the
		// write, or not counting until Pop loses the race) costs more than
		// this rare over-count is worth. ap_outbound_dropped_total is
		// documented as an upper bound for exactly this reason.
		q.messages = q.messages[1:]
		q.dropped++
		q.head++
	}
	q.messages = append(q.messages, msg)
}

// Peek returns the oldest queued message without removing it, plus the
// sequence number to pass back to Pop, and whether there was a message at
// all. The writer uses Peek+Pop instead of a drain-then-write loop so a
// message that fails to write is still sitting at the front of the queue
// afterward, in its original position relative to both what was already
// behind it and whatever Push adds while the write was in flight — nothing
// was ever removed to lose. It also keeps a still-unwritten message
// eligible for Push's ordinary drop-oldest accounting, which is correct:
// past the write deadline it *is* the oldest thing queued.
func (q *Queue) Peek() (msg []byte, seq uint64, ok bool) {
	q.mu.Lock()
	defer q.mu.Unlock()
	if len(q.messages) == 0 {
		return nil, 0, false
	}
	return q.messages[0], q.head, true
}

// Pop removes the oldest queued message, but only if seq (from Peek) still
// names it — i.e. nothing has removed it already. Call it only after that
// message has been handed off successfully. Reports whether it actually
// removed anything; false means the frame Peek named is already gone
// (drop-oldest beat it there while the write was in flight), which is not
// an error — the write still happened, Pop just has nothing left to do.
func (q *Queue) Pop(seq uint64) bool {
	q.mu.Lock()
	defer q.mu.Unlock()
	if len(q.messages) == 0 || q.head != seq {
		return false
	}
	q.messages = q.messages[1:]
	q.head++
	return true
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
