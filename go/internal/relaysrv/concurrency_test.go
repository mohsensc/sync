package relaysrv

import (
	"fmt"
	"sync"
	"testing"
)

// TestConcurrentClaimsAcrossRoomsAndRegions hammers the sharded registry
// from many goroutines at once — the property the per-path shard design
// exists for (see leases.go's shard doc comment) and the one thing a
// single-process VirtualClock test can't exercise: real concurrent access
// to the same room, the same path, and the shared agent index. Run with
// `-race`; nothing here asserts on timing, only that the registry stays
// internally consistent (every claim it hands back is coherent) under
// concurrent writers.
func TestConcurrentClaimsAcrossRoomsAndRegions(t *testing.T) {
	clock := RealClock{}
	pub := &fakePublisher{}
	reg := NewRegistry(clock, pub)

	const goroutines = 64
	const opsEach = 200
	const rooms = 4
	const paths = 6

	var wg sync.WaitGroup
	for g := 0; g < goroutines; g++ {
		wg.Add(1)
		go func(g int) {
			defer wg.Done()
			agent := fmt.Sprintf("agent-%d", g)
			for i := 0; i < opsEach; i++ {
				room := fmt.Sprintf("room-%d", (g+i)%rooms)
				region := Region{Path: fmt.Sprintf("src/file%d.py", (g*7+i)%paths)}
				res := reg.Acquire(room, "human", agent, region, "work", nil, PriorityNormal, nil)
				if res.Ok {
					// Hold it briefly against concurrent contention, then
					// let go — exercising acquire, contend and release all
					// at once across shards.
					reg.Heartbeat(room, agent, region, nil)
					reg.Release(room, agent, region, nil)
				} else if res.Decision == decisionAbort {
					reg.ReleaseAll(room, agent, nil)
				}
			}
		}(g)
	}
	wg.Wait()

	// Sanity: every claim left standing is internally coherent — same
	// invariant _live() is supposed to hold everywhere (one holder per
	// region, no orphaned contenders pointing at a departed claim).
	for r := 0; r < rooms; r++ {
		room := fmt.Sprintf("room-%d", r)
		claims := reg.ActiveClaims(room, nil)
		seen := map[string]bool{}
		for _, c := range claims {
			key := claimKey(c.Scope)
			if seen[key] {
				t.Fatalf("room %s: two live claims on the same region %v", room, c.Scope)
			}
			seen[key] = true
		}
	}
}

// TestConcurrentSendNeverBlocks exercises WsConn.Send from many goroutines
// at once against a queue small enough to force the drop-oldest path
// constantly — the property that matters is that it returns, never that a
// particular frame survives.
func TestConcurrentSendNeverBlocks(t *testing.T) {
	c := &WsConn{clock: RealClock{}, out: make(chan []byte, 4), closed: make(chan struct{})}
	var wg sync.WaitGroup
	for g := 0; g < 32; g++ {
		wg.Add(1)
		go func(g int) {
			defer wg.Done()
			for i := 0; i < 200; i++ {
				c.Send(EncodeFrame(Frame{"g": g, "i": i}))
			}
		}(g)
	}
	wg.Wait()
}

// TestReleaseEverywhereSeesRoomsCreatedDuringItsOwnSweep guards against a
// snapshot-then-iterate race: ReleaseEverywhere used to copy the room map
// under a brief RLock and then iterate the copy after releasing it, so a
// room created in that window was invisible to that call — a real gap for
// the identity-reclaim path it backs (relay.go's dropStrandedClaims),
// even though the exact end-to-end exploit is narrow. Fixed by holding
// the read lock for the whole sweep, which also blocks concurrent room
// *creation* (not room traffic) for its short duration. This hammers many
// goroutines creating brand new rooms concurrently with repeated
// ReleaseEverywhere calls and checks the registry is left consistent
// (every claim any goroutine created has a plausible owner, none orphaned
// mid-sweep) — run under -race, since the property under test is a lock
// gap, not a single-threaded assertion.
func TestReleaseEverywhereSeesRoomsCreatedDuringItsOwnSweep(t *testing.T) {
	clock := RealClock{}
	pub := &fakePublisher{}
	reg := NewRegistry(clock, pub)

	const agent = "reclaimed-agent"
	var wg sync.WaitGroup

	// One goroutine hammers ReleaseEverywhere for the identity being
	// reclaimed, the way dropStrandedClaims does on every join that wins
	// the id back.
	wg.Add(1)
	go func() {
		defer wg.Done()
		for i := 0; i < 200; i++ {
			reg.ReleaseEverywhere(agent, nil)
		}
	}()

	// Many goroutines race to create brand new rooms and immediately
	// claim a region in them under the same agent id — exactly the
	// pattern the race window would have to land in to matter.
	for g := 0; g < 16; g++ {
		wg.Add(1)
		go func(g int) {
			defer wg.Done()
			for i := 0; i < 50; i++ {
				room := fmt.Sprintf("fresh-room-%d-%d", g, i)
				reg.Acquire(room, "human", agent, Region{Path: "f.py"}, "work", nil, PriorityNormal, nil)
			}
		}(g)
	}
	wg.Wait()

	// No assertion on final state beyond "did not race and did not
	// panic" — -race is the actual check here. A best-effort sanity pass:
	// every room's claim table stays internally coherent.
	for r := 0; r < 16; r++ {
		for i := 0; i < 50; i++ {
			room := fmt.Sprintf("fresh-room-%d-%d", r, i)
			claims := reg.ActiveClaims(room, nil)
			if len(claims) > 1 {
				t.Fatalf("room %s: expected at most one claim, got %d", room, len(claims))
			}
		}
	}
}
