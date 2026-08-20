package devproxy

import (
	"testing"
	"time"
)

// clockAt makes a *Lock deterministic: expiry tests advance a fake clock
// instead of sleeping 90 real seconds.
func clockAt(l *Lock, t time.Time) { l.now = func() time.Time { return t } }

func newTestLock() *Lock {
	l := NewLock(90 * time.Second)
	clockAt(l, time.Unix(0, 0))
	return l
}

func TestClaimGrantsWhenUnheld(t *testing.T) {
	l := newTestLock()
	granted, holder := l.Claim("me", "featA", 111, 4001, false)
	if !granted {
		t.Fatal("first claim on an empty lock must be granted")
	}
	if holder.Owner != "me" || holder.Port != 4001 {
		t.Fatalf("got %+v", holder)
	}
}

func TestClaimRefusesWithCurrentHolder(t *testing.T) {
	l := newTestLock()
	l.Claim("me", "featA", 111, 4001, false)

	granted, holder := l.Claim("someone-else", "featB", 222, 4002, false)
	if granted {
		t.Fatal("a live lease held by someone else must refuse")
	}
	if holder.Owner != "me" || holder.Worktree != "featA" || holder.PID != 111 {
		t.Fatalf("refusal must hand back the actual holder, got %+v", holder)
	}
}

func TestClaimIsARenewalForTheSameProcess(t *testing.T) {
	l := newTestLock()
	l.Claim("me", "featA", 111, 4001, false)

	// Same owner/worktree/pid renewing on a new port (vite restarted) —
	// this is the heartbeat path, must succeed without --force.
	granted, holder := l.Claim("me", "featA", 111, 4009, false)
	if !granted {
		t.Fatal("the current holder must be able to renew its own lease")
	}
	if holder.Port != 4009 {
		t.Fatalf("renewal must pick up the new port, got %+v", holder)
	}
}

func TestExpiryFreesADeadHoldersLease(t *testing.T) {
	l := newTestLock()
	l.Claim("dead", "featA", 111, 4001, false)

	// Past the 90s TTL with no heartbeat — the holder is presumed dead.
	clockAt(l, time.Unix(0, 0).Add(91*time.Second))

	granted, holder := l.Claim("alive", "featB", 222, 4002, false)
	if !granted {
		t.Fatal("an expired lease must not block a new claim")
	}
	if holder.Owner != "alive" {
		t.Fatalf("got %+v", holder)
	}
}

func TestForceBreaksALiveLease(t *testing.T) {
	l := newTestLock()
	l.Claim("incumbent", "featA", 111, 4001, false)

	granted, holder := l.Claim("operator", "featB", 222, 4002, true)
	if !granted {
		t.Fatal("--force must break a live lease, not refuse")
	}
	if holder.Owner != "operator" {
		t.Fatalf("got %+v", holder)
	}
}

func TestReleaseOnlyByTheCurrentHolder(t *testing.T) {
	l := newTestLock()
	l.Claim("me", "featA", 111, 4001, false)

	l.Release("someone-else", "featB", 222)
	if _, ok := l.Status(); !ok {
		t.Fatal("a release from a non-holder must not clear a live lease")
	}

	l.Release("me", "featA", 111)
	if _, ok := l.Status(); ok {
		t.Fatal("a release from the actual holder must clear the lease")
	}
}

func TestStatusReadsExpiredAsUnheld(t *testing.T) {
	l := newTestLock()
	l.Claim("me", "featA", 111, 4001, false)
	clockAt(l, time.Unix(0, 0).Add(91*time.Second))

	if _, ok := l.Status(); ok {
		t.Fatal("Status must not report an expired holder as live")
	}
}
