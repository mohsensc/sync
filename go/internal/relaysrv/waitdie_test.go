package relaysrv

import "testing"

func mkClaim(agent string, acquiredAt float64) *Claim {
	return &Claim{Room: "r1", Human: "h", Agent: agent, Scope: Region{Path: "a.py"},
		AcquiredAt: acquiredAt, ExpiresAt: acquiredAt + 90, Priority: PriorityNormal}
}

// Ported from python/tests/test_wait_die.py — resolve() is the one
// comparison in the whole system, so it gets the same direct coverage on
// both sides of the port.

func TestOlderRequesterWaitsForYoungerHolder(t *testing.T) {
	if got := resolveWaitDie("a1", 100.0, mkClaim("a2", 500.0), PriorityNormal); got != decisionWait {
		t.Fatalf("got %v, want wait", got)
	}
}

func TestYoungerRequesterAbortsAgainstOlderHolder(t *testing.T) {
	if got := resolveWaitDie("a2", 500.0, mkClaim("a1", 100.0), PriorityNormal); got != decisionAbort {
		t.Fatalf("got %v, want abort", got)
	}
}

func TestExactTiesBreakDeterministicallyByAgentID(t *testing.T) {
	fwd := resolveWaitDie("aaa", 100.0, mkClaim("bbb", 100.0), PriorityNormal)
	rev := resolveWaitDie("bbb", 100.0, mkClaim("aaa", 100.0), PriorityNormal)
	if fwd == rev {
		t.Fatalf("expected the tie break to differ by direction, got %v both ways", fwd)
	}
}

func TestRelationIsNeverSymmetric(t *testing.T) {
	// Property mirrors the hypothesis test in test_wait_die.py: no pair of
	// ages can have both directions say "wait", or a two-agent wait cycle
	// (deadlock) would be reachable.
	xs := []float64{0, 1, 2, 50, 99, 100, 100.5, 1000, 1e6}
	for _, x := range xs {
		for _, y := range xs {
			forward := resolveWaitDie("a1", x, mkClaim("a2", y), PriorityNormal)
			reverse := resolveWaitDie("a2", y, mkClaim("a1", x), PriorityNormal)
			if forward == decisionWait && reverse == decisionWait {
				t.Fatalf("both directions said wait for x=%v y=%v — a wait cycle is reachable", x, y)
			}
		}
	}
}

func TestAnOlderRequesterNeverPreempts(t *testing.T) {
	// Wait-die, not wound-wait: an older/more-entitled requester is told
	// "wait", never "abort" — and there is no third answer meaning "take
	// it". The holder's lease is never revoked.
	if got := resolveWaitDie("a1", 100.0, mkClaim("a2", 500.0), PriorityNormal); got == decisionAbort {
		t.Fatalf("an older requester was told to abort")
	}
}

func TestPriorityBreaksTiesBeforeAge(t *testing.T) {
	// A critical requester waits even against an older normal holder —
	// tier is the first component of the order key, age only breaks ties
	// within a tier.
	holder := mkClaim("a2", 100.0)
	holder.Priority = PriorityNormal
	got := resolveWaitDie("a1", 500.0, holder, PriorityCritical)
	if got != decisionWait {
		t.Fatalf("critical requester got %v, want wait", got)
	}
}
