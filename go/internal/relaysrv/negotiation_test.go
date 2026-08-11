package relaysrv

import "testing"

// Ported from python/tests/test_negotiation.py. relaysrv's Negotiator had
// no direct test coverage before this — the golden scenario and
// concurrency tests exercise it incidentally, but every move
// (DEFER/SPLIT/HANDOFF/PROCEED) and the brief itself needed its own
// pinned behavior, the same way python's suite has it.

var negR = Region{Path: "src/auth.py", Symbol: strp("sign_in")}
var negOther = Region{Path: "src/auth.py", Symbol: strp("sign_out")}

func newNegotiatorFixture() (*VirtualClock, *Registry, *Negotiator) {
	clock, reg, _ := newTestRegistry()
	reg.Acquire("r1", "sara", "a1", negR, "refactor session handling", nil, PriorityNormal, nil)
	return clock, reg, NewNegotiator(reg)
}

func TestBriefNamesTheHolderAndTheirIntent(t *testing.T) {
	_, _, n := newNegotiatorFixture()
	brief := n.Open("r1", "a2", 500.0, negR, PriorityNormal, "", nil)
	if brief == nil || brief.HolderAgent != "a1" || brief.HolderIntent != "refactor session handling" {
		t.Fatalf("got %+v", brief)
	}
}

func TestNoBriefWhenTheRegionIsFree(t *testing.T) {
	_, _, n := newNegotiatorFixture()
	if brief := n.Open("r1", "a2", 500.0, negOther, PriorityNormal, "", nil); brief != nil {
		t.Fatalf("expected no brief for a free region, got %+v", brief)
	}
}

func TestDeferDoesNotGrant(t *testing.T) {
	_, _, n := newNegotiatorFixture()
	outcome := n.Apply("r1", "a2", negR, "DEFER", "", nil, PriorityNormal, nil)
	if outcome.Granted {
		t.Fatalf("expected DEFER not to grant")
	}
}

func TestSplitGrantsADisjointRegion(t *testing.T) {
	_, reg, n := newNegotiatorFixture()
	outcome := n.Apply("r1", "a2", negOther, "SPLIT", "", nil, PriorityNormal, nil)
	if !outcome.Granted {
		t.Fatalf("expected SPLIT onto a disjoint region to grant, got %+v", outcome)
	}
	if held := reg.HolderOf("r1", negOther, nil); held == nil || held.Agent != "a2" {
		t.Fatalf("expected a2 to hold the split region, got %+v", held)
	}
}

func TestHandoffDropsTheRequesterClaimAndLeavesTheHolder(t *testing.T) {
	_, reg, n := newNegotiatorFixture()
	// a2 has to hold something first, or HANDOFF has nothing to drop.
	reg.Acquire("r1", "dev", "a2", negOther, "rename sign_out", nil, PriorityNormal, nil)
	if held := reg.HolderOf("r1", negOther, nil); held == nil || held.Agent != "a2" {
		t.Fatalf("fixture setup failed")
	}

	outcome := n.Apply("r1", "a2", negOther, "HANDOFF", "", nil, PriorityNormal, nil)
	if outcome.Granted || outcome.Action != "handoff" {
		t.Fatalf("got %+v", outcome)
	}
	if held := reg.HolderOf("r1", negOther, nil); held != nil {
		t.Fatalf("expected the handed-off region to be free, got %+v", held)
	}
	// Handing back your own region must not disturb anyone else's.
	if held := reg.HolderOf("r1", negR, nil); held == nil || held.Agent != "a1" {
		t.Fatalf("expected a1 to still hold its own region, got %+v", held)
	}
}

func TestProceedIsAlwaysAvailableAndIsLoggedAsAnOverride(t *testing.T) {
	_, _, n := newNegotiatorFixture()
	outcome := n.Apply("r1", "a2", negR, "PROCEED", "independent change", nil, PriorityNormal, nil)
	if !outcome.Granted || !outcome.LoggedOverride {
		t.Fatalf("got %+v", outcome)
	}
}

func TestUnknownMoveIsRejected(t *testing.T) {
	// Rejected, but as data. Panicking here would escape through the MCP
	// tool call and the agent would see a crash instead of an answer.
	_, _, n := newNegotiatorFixture()
	outcome := n.Apply("r1", "a2", negR, "ARGUE", "", nil, PriorityNormal, nil)
	if outcome.Granted || outcome.Action != "invalid_move" {
		t.Fatalf("got %+v", outcome)
	}
}

func TestSplitOntoTheContestedRegionIsRejectedNotSilentlyDeferred(t *testing.T) {
	_, reg, n := newNegotiatorFixture()
	outcome := n.Apply("r1", "a2", negR, "SPLIT", "", nil, PriorityNormal, nil)
	if outcome.Granted || outcome.Action != "split_rejected" {
		t.Fatalf("got %+v", outcome)
	}
	if outcome.Error == "" {
		t.Fatalf("expected an error naming the disjoint requirement")
	}
	if held := reg.HolderOf("r1", negR, nil); held == nil || held.Agent != "a1" {
		t.Fatalf("expected a1 to still hold negR, got %+v", held)
	}
}

func TestSplitClaimsTheNamedDisjointSubRegion(t *testing.T) {
	_, reg, n := newNegotiatorFixture()
	outcome := n.Apply("r1", "a2", negR, "SPLIT", "", &negOther, PriorityNormal, nil)
	if !outcome.Granted || outcome.Action != "split" {
		t.Fatalf("got %+v", outcome)
	}
	if held := reg.HolderOf("r1", negOther, nil); held == nil || held.Agent != "a2" {
		t.Fatalf("expected a2 to hold the split scope, got %+v", held)
	}
	// The holder keeps what it had.
	if held := reg.HolderOf("r1", negR, nil); held == nil || held.Agent != "a1" {
		t.Fatalf("expected a1 to keep negR, got %+v", held)
	}
}

func TestAWholeFileSplitIsNotDisjointFromASymbolHolder(t *testing.T) {
	_, _, n := newNegotiatorFixture()
	whole := Region{Path: "src/auth.py"}
	outcome := n.Apply("r1", "a2", negR, "SPLIT", "", &whole, PriorityNormal, nil)
	if outcome.Granted || outcome.Action != "split_rejected" {
		t.Fatalf("got %+v", outcome)
	}
}

func TestSplitOntoARegionSomeoneElseAlreadyHoldsIsRejected(t *testing.T) {
	_, reg, n := newNegotiatorFixture()
	reg.Acquire("r1", "kim", "a3", negOther, "already mine", nil, PriorityNormal, nil)
	outcome := n.Apply("r1", "a2", negR, "SPLIT", "", &negOther, PriorityNormal, nil)
	if outcome.Granted || outcome.Action != "split_rejected" {
		t.Fatalf("got %+v", outcome)
	}
}

func TestMoveNamesAreCaseInsensitive(t *testing.T) {
	_, _, n := newNegotiatorFixture()
	if !n.Apply("r1", "a2", negR, "split", "", &negOther, PriorityNormal, nil).Granted {
		t.Fatalf("expected lowercase split to be recognized")
	}
	if !n.Apply("r1", "a2", negR, "  Proceed  ", "", nil, PriorityNormal, nil).Granted {
		t.Fatalf("expected padded/mixed-case proceed to be recognized")
	}
}

func TestLowercaseDeferIsStillADefer(t *testing.T) {
	_, _, n := newNegotiatorFixture()
	if got := n.Apply("r1", "a2", negR, "defer", "", nil, PriorityNormal, nil).Action; got != "defer" {
		t.Fatalf("got %s, want defer", got)
	}
}

func TestAnInventedMoveReturnsAStructuredErrorInsteadOfRaising(t *testing.T) {
	_, _, n := newNegotiatorFixture()
	outcome := n.Apply("r1", "a2", negR, "ARGUE", "", nil, PriorityNormal, nil)
	if outcome.Granted || outcome.Action != "invalid_move" {
		t.Fatalf("got %+v", outcome)
	}
}

func TestAYoungerRequesterIsToldToAbort(t *testing.T) {
	_, _, n := newNegotiatorFixture()
	brief := n.Open("r1", "a2", 500.0, negR, PriorityNormal, "", nil)
	if brief == nil || brief.Decision != decisionAbort {
		t.Fatalf("got %+v", brief)
	}
}

func TestAnOlderRequesterIsToldToWait(t *testing.T) {
	_, _, n := newNegotiatorFixture()
	brief := n.Open("r1", "a2", -500.0, negR, PriorityNormal, "", nil)
	if brief == nil || brief.Decision != decisionWait {
		t.Fatalf("got %+v", brief)
	}
}
