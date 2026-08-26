package relaysrv

import (
	"fmt"
	"testing"

	"github.com/mohsensc/sync/go/internal/metrics"
)

// The carry map (see handOver) had exactly one exit: resumeCarry, which
// fires only when the same agent re-takes the same region. Everything here
// covers the exits it was missing.

// carryLen peeks without creating the room. shardFor would resolve through
// roomOf, which creates a missing room — enough to make a reaped room look
// alive again to the very assertion checking it was reaped.
func carryLen(reg *Registry, room, path string) int {
	reg.roomsMu.RLock()
	rs, ok := reg.rooms[room]
	reg.roomsMu.RUnlock()
	if !ok {
		return -1
	}
	s := rs.shards[fnv32(path)%shardsPerRoom]
	s.mu.Lock()
	defer s.mu.Unlock()
	return len(s.carry)
}

func roomExists(reg *Registry, room string) bool {
	reg.roomsMu.RLock()
	defer reg.roomsMu.RUnlock()
	_, ok := reg.rooms[room]
	return ok
}

// A contended release leaves a carry entry behind. If its agent never
// returns, that one entry used to keep the whole room — sixteen shards,
// their mutexes and maps — alive for the life of the process.
func TestStaleCarryDoesNotPinTheRoomOpen(t *testing.T) {
	clock := NewVirtualClock(1000.0)
	rel := NewRelay(clock, InertRoster(), metrics.New())
	reg := rel.registry

	holder := &recorder{agent: "holder", human: "H"}
	asker := &recorder{agent: "asker", human: "A"}
	rel.Join("r1", holder)
	rel.Join("r1", asker)
	rel.Handle(holder, claimFrame("src/a.go"))

	clock.Advance(5)
	rel.Handle(asker, contendFrame("src/a.go"))

	// The holder lets go well before the deadline it was given, so the ask
	// is carried rather than honoured.
	rel.Handle(holder, map[string]any{"type": "release", "region": goldenRegion("src/a.go", "")})
	if carryLen(reg, "r1", "src/a.go") != 1 {
		t.Fatal("expected the contended release to leave a carry entry")
	}

	// Both walk away and never come back.
	rel.Leave(holder)
	rel.Leave(asker)
	clock.Advance(FairShareGraceS + LeaseTTLS + 1)
	reg.SweepAll()

	if roomExists(reg, "r1") {
		t.Fatalf("room with no claims, no reservations and only stale carry should be reaped, carry=%d",
			carryLen(reg, "r1", "src/a.go"))
	}
}

// carryMax was never a cap: eviction only ever considered entries whose
// deadline had already passed, so a shard taking a steady stream of
// contended releases grew past the limit unchecked.
func TestCarryIsCappedByLiveEntriesToo(t *testing.T) {
	clock := NewVirtualClock(1000.0)
	rel := NewRelay(clock, InertRoster(), metrics.New())
	reg := rel.registry

	holder := &recorder{agent: "holder", human: "H"}
	asker := &recorder{agent: "asker", human: "A"}
	rel.Join("r1", holder)
	rel.Join("r1", asker)

	// One path, so everything lands in one shard; a distinct symbol each
	// time, so every claim is its own region and its own carry key. Every
	// deadline is far in the future, so the expired-only pass finds nothing.
	const path = "src/big.go"
	for i := 0; i < carryMax+40; i++ {
		sym := fmt.Sprintf("Sym%d", i)
		region := goldenRegion(path, sym)
		rel.Handle(holder, map[string]any{"type": "claim", "region": region, "intent": "work"})
		rel.Handle(asker, map[string]any{"type": "contend", "region": region})
		rel.Handle(holder, map[string]any{"type": "release", "region": region})
	}

	if got := carryLen(reg, "r1", path); got > carryMax {
		t.Fatalf("carry grew to %d, past carryMax %d, with nothing expired", got, carryMax)
	}
}

// carry is keyed by the departing holder but stores a snapshot of the
// winning *contender*, so a departed contender survived there after
// pruneContendersLocked had cleared it everywhere else — and resumeCarry
// would hand it back to a fresh claim, where it won a reservation nobody
// could use.
func TestDepartedContenderIsNotResurrectedFromCarry(t *testing.T) {
	clock := NewVirtualClock(1000.0)
	rel := NewRelay(clock, InertRoster(), metrics.New())
	reg := rel.registry

	holder := &recorder{agent: "holder", human: "H"}
	asker := &recorder{agent: "asker", human: "A"}
	rel.Join("r1", holder)
	rel.Join("r1", asker)
	rel.Handle(holder, claimFrame("src/a.go"))

	clock.Advance(5)
	rel.Handle(asker, contendFrame("src/a.go"))
	rel.Handle(holder, map[string]any{"type": "release", "region": goldenRegion("src/a.go", "")})
	if carryLen(reg, "r1", "src/a.go") != 1 {
		t.Fatal("expected a carry entry to carry the ask forward")
	}

	// The contender's session ends. Its ask should not outlive it.
	rel.Leave(asker)
	if carryLen(reg, "r1", "src/a.go") != 0 {
		t.Fatal("a departed contender's carried ask should be dropped with it")
	}

	// The holder comes back to the same region: nothing to resume, so no
	// deadline and no handover to a connection that is gone.
	clock.Advance(1)
	rel.Handle(holder, claimFrame("src/a.go"))
	h := reg.HolderOf("r1", regionOf("src/a.go"), nil)
	if h == nil {
		t.Fatal("holder should hold its own region again")
	}
	if h.HandoverAt != nil || h.Winner != nil {
		t.Fatalf("a departed contender came back through carry: handoverAt=%v winner=%+v", h.HandoverAt, h.Winner)
	}

	// And a live contender can still take the region rather than waiting
	// out a reservation minted for the ghost.
	third := &recorder{agent: "third", human: "T"}
	rel.Join("r1", third)
	clock.Advance(LeaseTTLS + 1)
	reg.SweepAll()
	if res := reg.ReservationFor("r1", regionOf("src/a.go"), nil); res != nil {
		t.Fatalf("region reserved for %q, which is gone", res.Agent)
	}
}

// The dodge this all exists to prevent still works: a holder that releases
// and immediately re-takes a region inherits the deadline it was given.
func TestCarryStillStopsTheDeadlineDodge(t *testing.T) {
	clock := NewVirtualClock(1000.0)
	rel := NewRelay(clock, InertRoster(), metrics.New())

	holder := &recorder{agent: "holder", human: "H"}
	asker := &recorder{agent: "asker", human: "A"}
	rel.Join("r1", holder)
	rel.Join("r1", asker)
	rel.Handle(holder, claimFrame("src/a.go"))

	clock.Advance(5)
	rel.Handle(asker, contendFrame("src/a.go"))
	deadline := *rel.registry.HolderOf("r1", regionOf("src/a.go"), nil).HandoverAt

	rel.Handle(holder, map[string]any{"type": "release", "region": goldenRegion("src/a.go", "")})
	clock.Advance(1)
	rel.Handle(holder, claimFrame("src/a.go"))

	h := rel.registry.HolderOf("r1", regionOf("src/a.go"), nil)
	if h == nil || h.HandoverAt == nil {
		t.Fatalf("re-taking the region should inherit the carried deadline, got %+v", h)
	}
	if *h.HandoverAt != deadline {
		t.Fatalf("carried deadline = %v, want the original %v", *h.HandoverAt, deadline)
	}
}
