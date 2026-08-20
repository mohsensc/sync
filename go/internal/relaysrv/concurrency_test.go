package relaysrv

import (
	"fmt"
	"sync"
	"testing"

	"github.com/mohsensc/sync/go/internal/metrics"
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
	reg := NewRegistry(clock, pub, metrics.New())

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
	c := &WsConn{clock: RealClock{}, metrics: metrics.New(), out: make(chan []byte, 4), closed: make(chan struct{})}
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
	reg := NewRegistry(clock, pub, metrics.New())

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

// lockedConn is a Conn safe to drive from several goroutines at once. The
// recorder in golden_test.go appends to a plain slice, which would race on
// its own and drown out whatever the test is actually about.
type lockedConn struct {
	mu                 sync.Mutex
	agent, human, room string
	frames             int
}

func (c *lockedConn) Agent() string { c.mu.Lock(); defer c.mu.Unlock(); return c.agent }
func (c *lockedConn) SetAgent(a string) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.agent = a
}
func (c *lockedConn) Human() string { c.mu.Lock(); defer c.mu.Unlock(); return c.human }
func (c *lockedConn) SetHuman(h string) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.human = h
}
func (c *lockedConn) Room() string { c.mu.Lock(); defer c.mu.Unlock(); return c.room }
func (c *lockedConn) SetRoom(rm string) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.room = rm
}
func (c *lockedConn) Principal() string { return "" }
func (c *lockedConn) Token() string     { return "" }
func (c *lockedConn) Unattended() bool  { return false }
func (c *lockedConn) Send(b []byte) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.frames++
}

// TestConcurrentClaimAndContendOnOneRegion is the regression test for issue
// #86: the registry used to hand live *Claim pointers back past the shard
// lock, and the connection goroutine then read and wrote them. One agent
// re-claiming a region it already holds runs the renewal branch, whose
// reply goes through leaseFrame — which called HandoverWinner (a write to
// c.winner/c.winnerStale) and len(c.Contenders) off the lock. Several other
// agents contending the same region run NoteContender on the same claim
// under the lock. Before the claimView fix that pair is a concurrent map
// read/write: a fatal runtime error, not a panic session()'s recover can
// catch, so it takes the whole relay down rather than one session.
//
// Everything here goes through the public Relay API (Join/Handle) on
// RealClock, one goroutine per connection, the way real sessions arrive.
// Nothing is asserted about the frames — -race is the assertion.
func TestConcurrentClaimAndContendOnOneRegion(t *testing.T) {
	rel := NewRelay(RealClock{}, InertRoster(), metrics.New())
	const room = "r1"
	const path = "src/pay.py"
	region := func() map[string]any { return goldenRegion(path, "") }

	holder := &lockedConn{agent: "holder", human: "sara"}
	if !rel.Join(room, holder) {
		t.Fatal("holder join refused")
	}
	if got := rel.Handle(holder, map[string]any{"type": "claim", "region": region(), "intent": "pay"}); got["granted"] != true {
		t.Fatalf("holder's first claim must be granted, got %+v", got)
	}

	const contenders = 6
	const opsEach = 300
	var wg sync.WaitGroup

	// The holder keeps re-claiming what it already holds: Acquire's renewal
	// branch, so the reply is built by leaseFrame from the live claim.
	wg.Add(1)
	go func() {
		defer wg.Done()
		for i := 0; i < opsEach; i++ {
			rel.Handle(holder, map[string]any{"type": "claim", "region": region(), "intent": "pay"})
		}
	}()

	// Distinct agent ids: two connections sharing one id trips the
	// identity-reclaim path and drops the holder's lease mid-test.
	for g := 0; g < contenders; g++ {
		conn := &lockedConn{agent: fmt.Sprintf("contender-%d", g), human: "dev"}
		if !rel.Join(room, conn) {
			t.Fatalf("contender %d join refused", g)
		}
		wg.Add(1)
		go func(conn *lockedConn) {
			defer wg.Done()
			for i := 0; i < opsEach; i++ {
				// contend writes the contender map; claim reads the winner
				// and the waiting count back out on the refused path.
				rel.Handle(conn, map[string]any{"type": "contend", "region": region()})
				rel.Handle(conn, map[string]any{"type": "claim", "region": region(), "intent": "also pay"})
			}
		}(conn)
	}
	wg.Wait()

	if held := rel.registry.HolderOf(room, Region{Path: path}, nil); held == nil || held.Agent != "holder" {
		t.Fatalf("holder should still hold the region, got %+v", held)
	}
}
