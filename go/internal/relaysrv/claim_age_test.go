package relaysrv

import (
	"testing"

	"github.com/mohsensc/sync/go/internal/metrics"
)

// docs/policy-design.md §5.4: every live claim an agent holds must carry
// the same acquired_at, and it must equal the age the registry hands out
// for that agent. Acquire used to read the age and write it back in two
// separate agentMu critical sections, so a second connection sharing the
// agent id (which bindAgent allows at a matching tier) could land a
// release-then-claim in the gap and leave the two disagreeing.

// Note on what is NOT here: a test that reproduces the lost update itself.
// The window was the few instructions between Acquire's age read and its
// write-back, and hitting it needs a second connection to release the
// agent's last claim and re-claim inside that gap. A stress test hammering
// two connections on one agent id passes against the old code as readily as
// against the new, so it would be a test that proves nothing. Reproducing it
// deterministically means a pause hook in the production path, which is not
// worth carrying to pin a window the fix removes by construction. The tests
// below cover the behaviour on either side of it.

// The plain sequential behaviour latchClaimAge replaced: a second claim
// inherits the first's age rather than minting a new one.
func TestSecondClaimInheritsTheFirstsAge(t *testing.T) {
	clock := NewVirtualClock(1000.0)
	reg := NewRegistry(clock, &fakePublisher{}, metrics.New())

	first := reg.Acquire("r1", "H", "x", Region{Path: "src/a.go"}, "work", nil, PriorityNormal, nil)
	if !first.Ok {
		t.Fatal("first claim should be granted")
	}
	clock.Advance(50)
	second := reg.Acquire("r1", "H", "x", Region{Path: "src/b.go"}, "work", nil, PriorityNormal, nil)
	if !second.Ok {
		t.Fatal("second claim should be granted")
	}
	if second.Claim.AcquiredAt != first.Claim.AcquiredAt {
		t.Fatalf("second claim aged %v, want the first's %v — a second lease must not re-age the agent",
			second.Claim.AcquiredAt, first.Claim.AcquiredAt)
	}
	if got := reg.AgeOf("x"); got != first.Claim.AcquiredAt {
		t.Fatalf("cached age %v disagrees with the claims' %v", got, first.Claim.AcquiredAt)
	}
}

// Releasing everything clears the accrued age, so the next claim is genuinely
// fresh — latchClaimAge must not have latched it into permanence.
func TestAgeClearsOnceEverythingIsReleased(t *testing.T) {
	clock := NewVirtualClock(1000.0)
	reg := NewRegistry(clock, &fakePublisher{}, metrics.New())

	scope := Region{Path: "src/a.go"}
	first := reg.Acquire("r1", "H", "x", scope, "work", nil, PriorityNormal, nil)
	reg.Release("r1", "x", scope, nil)
	clock.Advance(60)
	again := reg.Acquire("r1", "H", "x", scope, "work", nil, PriorityNormal, nil)
	if again.Claim.AcquiredAt == first.Claim.AcquiredAt {
		t.Fatal("a voluntary release of the last claim should clear the accrued age")
	}
	if again.Claim.AcquiredAt != 1060 {
		t.Fatalf("re-claim aged %v, want the clock's 1060", again.Claim.AcquiredAt)
	}
}
