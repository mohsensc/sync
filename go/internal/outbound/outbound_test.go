package outbound

import "testing"

func msg(s string) []byte { return []byte(s) }

// popMust pops the current front (via Peek's seq) and fails the test if
// nothing was there or Pop refused.
func popMust(t *testing.T, q *Queue) []byte {
	t.Helper()
	got, seq, ok := q.Peek()
	if !ok {
		t.Fatal("Peek reported empty")
	}
	if !q.Pop(seq) {
		t.Fatal("Pop refused a seq Peek just handed back")
	}
	return got
}

func TestPushPopOrder(t *testing.T) {
	q := New(10)
	q.Push(msg("a"))
	q.Push(msg("b"))
	q.Push(msg("c"))

	for _, want := range []string{"a", "b", "c"} {
		if got := popMust(t, q); string(got) != want {
			t.Errorf("popped %q, want %q", got, want)
		}
	}
	if _, _, ok := q.Peek(); ok {
		t.Error("Peek on empty queue reported ok, want false")
	}
}

func TestPeekDoesNotRemove(t *testing.T) {
	q := New(10)
	q.Push(msg("a"))
	q.Push(msg("b"))

	for i := 0; i < 3; i++ {
		got, _, ok := q.Peek()
		if !ok || string(got) != "a" {
			t.Fatalf("Peek #%d = %q, %v, want \"a\", true", i, got, ok)
		}
	}
	if q.Len() != 2 {
		t.Errorf("Len after repeated Peek = %d, want 2 (Peek must not remove)", q.Len())
	}
}

func TestPeekEmpty(t *testing.T) {
	q := New(10)
	if _, _, ok := q.Peek(); ok {
		t.Error("Peek on empty queue reported ok, want false")
	}
}

func TestPopEmpty(t *testing.T) {
	q := New(10)
	if q.Pop(0) {
		t.Error("Pop on empty queue reported success, want false")
	}
}

// TestDropOldestAtCapacity is the drop-oldest contract Push's own comment
// promises: once the queue is full, the next Push evicts the front (oldest)
// entry rather than refusing the new one or growing past cap.
func TestDropOldestAtCapacity(t *testing.T) {
	q := New(3)
	q.Push(msg("a"))
	q.Push(msg("b"))
	q.Push(msg("c"))
	q.Push(msg("d")) // queue full at "a","b","c" -> "a" evicted

	if q.Len() != 3 {
		t.Fatalf("Len = %d, want 3 (capacity must not be exceeded)", q.Len())
	}
	if got := q.Dropped(); got != 1 {
		t.Errorf("Dropped = %d, want 1", got)
	}
	for _, want := range []string{"b", "c", "d"} {
		if got := popMust(t, q); string(got) != want {
			t.Errorf("popped %q, want %q", got, want)
		}
	}
}

// TestCapacityZeroDropsEverything matches the C++ side's rule, per Push's
// comment: a Queue built with capacity 0 accepts nothing and counts every
// Push as a drop.
func TestCapacityZeroDropsEverything(t *testing.T) {
	q := New(0)
	q.Push(msg("a"))
	q.Push(msg("b"))

	if q.Len() != 0 {
		t.Errorf("Len = %d, want 0", q.Len())
	}
	if got := q.Dropped(); got != 2 {
		t.Errorf("Dropped = %d, want 2", got)
	}
}

// TestPeekPopRetriesOnFailure exercises the failure path client.writePump
// relies on: Peek a message, simulate a failed write by doing nothing (no
// Pop), and confirm the message is still there, still first, on the next
// attempt — with anything pushed in the meantime landing behind it in
// order, not ahead of or mixed into it. This is the scenario that used to
// lose frames: Drain used to remove the whole batch up front, so a write
// error partway through it dropped the failed frame and everything queued
// behind it for good.
func TestPeekPopRetriesOnFailure(t *testing.T) {
	q := New(10)
	q.Push(msg("stuck"))

	// First attempt: peek the frame, "write" fails, never Pop.
	got, _, ok := q.Peek()
	if !ok || string(got) != "stuck" {
		t.Fatalf("Peek = %q, %v, want \"stuck\", true", got, ok)
	}

	// More frames queue up while "stuck" is still waiting to go out — same
	// as new hook events arriving during a reconnect backoff.
	q.Push(msg("next1"))
	q.Push(msg("next2"))

	// Retry: the previously-failed frame must still be first.
	got, seq, ok := q.Peek()
	if !ok || string(got) != "stuck" {
		t.Fatalf("Peek after retry = %q, %v, want \"stuck\", true (frame must not be lost or reordered)", got, ok)
	}

	// This time the write "succeeds".
	if !q.Pop(seq) {
		t.Fatal("Pop refused a seq Peek just handed back")
	}

	for _, want := range []string{"next1", "next2"} {
		if got := popMust(t, q); string(got) != want {
			t.Errorf("popped %q, want %q", got, want)
		}
	}
}

// TestPeekPopUnderCapacityPressure covers the interleaving the fix has to
// get right: a frame stuck at the front (failed write, not yet popped)
// must itself be eligible for drop-oldest once enough new frames arrive to
// fill the queue behind it — it's the oldest thing queued, so ordinary
// Push pressure is allowed to shed it exactly like any other entry.
func TestPeekPopUnderCapacityPressure(t *testing.T) {
	q := New(2)
	q.Push(msg("stuck"))
	if _, _, ok := q.Peek(); !ok {
		t.Fatal("Peek reported empty right after Push")
	}

	q.Push(msg("b"))
	q.Push(msg("c")) // queue full at "stuck","b" -> "stuck" evicted

	if got := q.Dropped(); got != 1 {
		t.Errorf("Dropped = %d, want 1", got)
	}
	got, _, ok := q.Peek()
	if !ok || string(got) != "b" {
		t.Fatalf("Peek = %q, %v, want \"b\", true (the stuck frame should have been the one dropped)", got, ok)
	}
}

// TestPopRefusesStaleSeq is the race client.writePump depends on: a frame
// is Peeked (write "succeeds" on it), but before Pop runs, drop-oldest
// evicts that exact frame and promotes the next one to the front. Pop must
// refuse — using the stale seq to remove "whatever is at the front now"
// would delete the next frame, which was never written.
func TestPopRefusesStaleSeq(t *testing.T) {
	q := New(2)
	q.Push(msg("a"))
	q.Push(msg("b"))

	got, seq, ok := q.Peek()
	if !ok || string(got) != "a" {
		t.Fatalf("Peek = %q, %v, want \"a\", true", got, ok)
	}

	// Simulate a write of "a" landing, then two more pushes racing ahead
	// of the Pop that confirms it — enough for drop-oldest to evict "a"
	// (already written) and then "b" (never written).
	q.Push(msg("c")) // full at a,b -> evicts a, queue is b,c
	q.Push(msg("d")) // full at b,c -> evicts b, queue is c,d

	if q.Pop(seq) {
		t.Fatal("Pop succeeded on a seq that had already been evicted")
	}
	// Nothing was removed by the stale Pop: front is still "c".
	got, _, ok = q.Peek()
	if !ok || string(got) != "c" {
		t.Fatalf("Peek after stale Pop = %q, %v, want \"c\", true (stale Pop must not delete an unrelated frame)", got, ok)
	}
	if got := q.Dropped(); got != 2 {
		t.Errorf("Dropped = %d, want 2 (a and b both evicted by drop-oldest)", got)
	}
}
