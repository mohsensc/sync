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
	c := &WsConn{clock: RealClock{}, out: make(chan Frame, 4), closed: make(chan struct{})}
	var wg sync.WaitGroup
	for g := 0; g < 32; g++ {
		wg.Add(1)
		go func(g int) {
			defer wg.Done()
			for i := 0; i < 200; i++ {
				c.Send(Frame{"g": g, "i": i})
			}
		}(g)
	}
	wg.Wait()
}
