package relaysrv

import (
	"testing"

	"github.com/mohsensc/sync/go/internal/metrics"
)

// issue #174: a contender that disconnects was never removed from the
// claim it asked for. The holder lost the lease at a deadline set by an
// agent that was long gone, and the region was then reserved for a name
// nobody could ever heartbeat.
func TestGhostContenderDoesNotTakeTheHandover(t *testing.T) {
	clock := NewVirtualClock(1000.0)
	rel := NewRelay(clock, InertRoster(), metrics.New())

	holder := &recorder{agent: "holder", human: "H"}
	asker := &recorder{agent: "asker", human: "A"}
	rel.Join("r1", holder)
	rel.Join("r1", asker)

	rel.Handle(holder, map[string]any{"type": "claim", "region": goldenRegion("src/a.go", ""), "intent": "work"})

	// asker contends, capping the holder's renewal.
	clock.Advance(5)
	rel.Handle(asker, map[string]any{"type": "contend", "region": goldenRegion("src/a.go", "")})
	h := rel.registry.HolderOf("r1", Region{Path: "src/a.go"}, nil)
	if h.HandoverAt == nil || h.Winner == nil || h.Winner.Agent != "asker" {
		t.Fatalf("expected asker's contend to cap the holder, got %+v", h)
	}
	deadline := *h.HandoverAt

	// asker's session ends immediately.
	rel.Leave(asker)
	h = rel.registry.HolderOf("r1", Region{Path: "src/a.go"}, nil)
	if h.Waiting != 0 || h.Winner != nil {
		t.Fatalf("asker should be pruned on Leave, still see it: %+v", h)
	}
	if h.HandoverAt != nil {
		t.Fatalf("cap should drop with no contenders left, still capped at %v", *h.HandoverAt)
	}

	// Holder heartbeats diligently right past the old (ghost-set) deadline.
	for clock.Now() < deadline+30 {
		clock.Advance(30)
		rel.Handle(holder, map[string]any{"type": "heartbeat", "region": goldenRegion("src/a.go", "")})
	}
	if got := rel.registry.HolderOf("r1", Region{Path: "src/a.go"}, holder); got == nil {
		t.Fatal("holder should still hold the lease past the ghost's deadline")
	}

	// The region is claimable by a live peer, not reserved for the ghost.
	third := &recorder{agent: "third", human: "T"}
	rel.Join("r1", third)
	if r := rel.registry.ReservationFor("r1", Region{Path: "src/a.go"}, nil); r != nil {
		t.Fatalf("region should not be reserved for a departed contender, got %+v", r)
	}

	// The holder's own renewal still works too.
	reply := rel.Handle(holder, map[string]any{"type": "claim", "region": goldenRegion("src/a.go", ""), "intent": "work"})
	if reply["granted"] != true {
		t.Fatalf("holder's own re-claim should just renew, got %+v", reply)
	}
}

// Pruning one departed contender must leave a still-live contender's ask
// (and the winner it might be) intact.
func TestPruneOneContenderLeavesOtherContendersIntact(t *testing.T) {
	clock := NewVirtualClock(1000.0)
	rel := NewRelay(clock, InertRoster(), metrics.New())

	holder := &recorder{agent: "holder", human: "H"}
	early := &recorder{agent: "early", human: "E"} // asks first -> earlier FirstAskedAt -> wins the min
	late := &recorder{agent: "late", human: "L"}
	rel.Join("r1", holder)
	rel.Join("r1", early)
	rel.Join("r1", late)

	rel.Handle(holder, map[string]any{"type": "claim", "region": goldenRegion("src/a.go", ""), "intent": "work"})

	clock.Advance(5)
	rel.Handle(early, map[string]any{"type": "contend", "region": goldenRegion("src/a.go", "")})
	clock.Advance(5)
	rel.Handle(late, map[string]any{"type": "contend", "region": goldenRegion("src/a.go", "")})

	h := rel.registry.HolderOf("r1", Region{Path: "src/a.go"}, nil)
	if h.Waiting != 2 || h.Winner == nil || h.Winner.Agent != "early" {
		t.Fatalf("expected both contenders with early winning, got %+v", h)
	}

	// The winner (early) disconnects; late is still around.
	rel.Leave(early)

	h = rel.registry.HolderOf("r1", Region{Path: "src/a.go"}, nil)
	if h.Waiting != 1 {
		t.Fatalf("expected exactly one contender left, got waiting=%d", h.Waiting)
	}
	if h.Winner == nil || h.Winner.Agent != "late" {
		t.Fatalf("winner should recompute to the remaining contender, got %+v", h.Winner)
	}
	if h.HandoverAt == nil {
		t.Fatal("a live contender remains; the cap should still be set")
	}
}
