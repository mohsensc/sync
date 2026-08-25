package relaysrv

import (
	"testing"

	"github.com/mohsensc/sync/go/internal/metrics"
)

// Opening a brief is an ask: Negotiator.Open calls Contend, which records
// the requester as a contender and pulls the holder's HandoverAt — and its
// ExpiresAt with it — down to the grace deadline.
//
// DEFER used to return an outcome and touch nothing else, so the ask
// outlived the decision that withdrew it. At the deadline the region was
// reserved for, and then granted to, the exact agent that had said "you
// keep it, I'm backing off".
func TestDeferWithdrawsTheAskItAnswers(t *testing.T) {
	clock := NewVirtualClock(1000.0)
	reg := NewRegistry(clock, &fakePublisher{}, metrics.New())
	neg := NewNegotiator(reg)

	scope := Region{Path: "src/a.go"}
	if r := reg.Acquire("r1", "H", "holder", scope, "work", nil, PriorityNormal, nil); !r.Ok {
		t.Fatal("holder should get the lease")
	}

	clock.Advance(5)
	brief := neg.Open("r1", "asker", reg.AgeOf("asker"), scope, PriorityNormal, "A", nil)
	if brief == nil {
		t.Fatal("a contested region should produce a brief")
	}
	held := reg.HolderOf("r1", scope, nil)
	if held.HandoverAt == nil || held.Winner == nil {
		t.Fatalf("opening the brief should have capped the holder, got %+v", held)
	}
	capped := held.ExpiresAt

	neg.Apply("r1", "asker", scope, "DEFER", "you keep it", nil, PriorityNormal, "A", nil)

	held = reg.HolderOf("r1", scope, nil)
	if held == nil {
		t.Fatal("deferring must not cost the holder its lease")
	}
	if held.HandoverAt != nil {
		t.Fatalf("the deadline should lift with the ask, still set to %v", *held.HandoverAt)
	}
	if held.Winner != nil {
		t.Fatalf("a deferring agent should not still be the handover winner, got %+v", held.Winner)
	}
	if held.Waiting != 0 {
		t.Fatalf("waiting should be back to zero, got %d", held.Waiting)
	}
	if held.ExpiresAt <= capped {
		t.Fatalf("the lease should stop expiring early: expiresAt %v, still at the capped %v",
			held.ExpiresAt, capped)
	}
}

// The whole point: after a DEFER, letting the clock run past where the
// deadline was must not hand the region to the agent that deferred.
func TestDeferredAskDoesNotWinTheRegionLater(t *testing.T) {
	clock := NewVirtualClock(1000.0)
	reg := NewRegistry(clock, &fakePublisher{}, metrics.New())
	neg := NewNegotiator(reg)

	scope := Region{Path: "src/a.go"}
	reg.Acquire("r1", "H", "holder", scope, "work", nil, PriorityNormal, nil)
	clock.Advance(5)
	neg.Open("r1", "asker", reg.AgeOf("asker"), scope, PriorityNormal, "A", nil)
	deadline := *reg.HolderOf("r1", scope, nil).HandoverAt

	neg.Apply("r1", "asker", scope, "DEFER", "you keep it", nil, PriorityNormal, "A", nil)

	// The holder carries on working, heartbeating as presenced would.
	for clock.Now() < deadline+HeartbeatS {
		clock.Advance(HeartbeatS)
		reg.Heartbeat("r1", "holder", scope, nil)
	}

	if reg.HolderOf("r1", scope, nil) == nil {
		t.Fatal("the holder lost its lease at a deadline the asker had already withdrawn")
	}
	if res := reg.ReservationFor("r1", scope, nil); res != nil {
		t.Fatalf("region reserved for %q, which deferred it", res.Agent)
	}
}

// Withdrawing one ask must not lift a deadline another contender is still
// owed — the cap belongs to whoever is still asking.
func TestDeferLeavesAnotherContendersDeadlineAlone(t *testing.T) {
	clock := NewVirtualClock(1000.0)
	reg := NewRegistry(clock, &fakePublisher{}, metrics.New())
	neg := NewNegotiator(reg)

	scope := Region{Path: "src/a.go"}
	reg.Acquire("r1", "H", "holder", scope, "work", nil, PriorityNormal, nil)
	clock.Advance(5)
	neg.Open("r1", "asker", reg.AgeOf("asker"), scope, PriorityNormal, "A", nil)
	neg.Open("r1", "other", reg.AgeOf("other"), scope, PriorityNormal, "O", nil)

	neg.Apply("r1", "asker", scope, "DEFER", "backing off", nil, PriorityNormal, "A", nil)

	held := reg.HolderOf("r1", scope, nil)
	if held.HandoverAt == nil {
		t.Fatal("the remaining contender is still owed a deadline")
	}
	if held.Winner == nil || held.Winner.Agent != "other" {
		t.Fatalf("the remaining contender should be the winner, got %+v", held.Winner)
	}
	if held.Waiting != 1 {
		t.Fatalf("waiting should count only the remaining ask, got %d", held.Waiting)
	}
}
