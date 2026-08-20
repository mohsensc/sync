package relaysrv

import (
	"fmt"
	"strings"
	"sync"
	"sync/atomic"
	"testing"

	"github.com/mohsensc/sync/go/internal/metrics"
)

// Ported from the audit probes (zz_probeC_test.go, zz_probeC2_test.go):
// issue #175 — neither Relay.rooms nor Registry.rooms was ever deleted
// from, so one connection joining N distinct room names permanently
// allocated N roomInfos and N*16 lease shards.

// TestRoomsReapedAfterMembersLeave is probeC: many joins from one
// connection, then Leave, then a registry sweep — both maps should return
// to (near) empty, not stay pinned at N.
func TestRoomsReapedAfterMembersLeave(t *testing.T) {
	clock := NewVirtualClock(1000.0)
	rel := NewRelay(clock, InertRoster(), metrics.New())
	c := &lockedConn{agent: "spray", human: "S"}

	const n = 2000
	for i := 0; i < n; i++ {
		if !rel.Join(fmt.Sprintf("room-%d", i), c) {
			t.Fatalf("join %d refused", i)
		}
	}
	rel.Leave(c)

	rel.roomsMu.RLock()
	nRelayRooms := len(rel.rooms)
	rel.roomsMu.RUnlock()

	if nRelayRooms != 0 {
		t.Fatalf("relay side: %d rooms retained after every member left, want 0", nRelayRooms)
	}

	// The registry side reaps lazily, from SweepAll — it has no
	// membership signal of its own (see leases.go's SweepAll doc
	// comment), so it isn't expected to be empty until a sweep runs.
	rel.registry.roomsMu.RLock()
	beforeSweep := len(rel.registry.rooms)
	rel.registry.roomsMu.RUnlock()
	if beforeSweep != n {
		t.Fatalf("registry side: expected all %d rooms still present pre-sweep (nothing ever claimed anything, so they were empty on arrival too — this just confirms the sweep, not Leave, is what reaps them), got %d", n, beforeSweep)
	}

	rel.registry.SweepAll()

	rel.registry.roomsMu.RLock()
	nRegRooms := len(rel.registry.rooms)
	rel.registry.roomsMu.RUnlock()
	if nRegRooms != 0 {
		t.Fatalf("registry side: %d rooms retained after a sweep with no live claims anywhere, want 0", nRegRooms)
	}
}

// TestRoomsStayWhileMembersRemain is the control: a room with a live
// member must not be reaped out from under it.
func TestRoomsStayWhileMembersRemain(t *testing.T) {
	clock := NewVirtualClock(1000.0)
	rel := NewRelay(clock, InertRoster(), metrics.New())
	c := &lockedConn{agent: "stays", human: "S"}
	if !rel.Join("sticky-room", c) {
		t.Fatal("join refused")
	}

	rel.roomsMu.RLock()
	n := len(rel.rooms)
	rel.roomsMu.RUnlock()
	if n != 1 {
		t.Fatalf("expected the joined room to still be tracked, got %d rooms", n)
	}
}

// TestLongRoomNamesRejected is probeC2's control: a room name over
// MaxRoomNameBytes must never reach Relay.Join at all — validRoomName is
// what server.go's session loop gates on before calling Join, so this
// tests it directly the way inbound_rate_limit_test.go tests
// admitInbound directly, without standing up a socket.
func TestLongRoomNamesRejected(t *testing.T) {
	ok := strings.Repeat("x", MaxRoomNameBytes)
	if !validRoomName(ok) {
		t.Fatalf("a room name at exactly MaxRoomNameBytes (%d) should be accepted", MaxRoomNameBytes)
	}
	tooLong := strings.Repeat("x", MaxRoomNameBytes+1)
	if validRoomName(tooLong) {
		t.Fatalf("a room name over MaxRoomNameBytes (%d) should be rejected", MaxRoomNameBytes)
	}
	huge := strings.Repeat("x", 60000)
	if validRoomName(huge) {
		t.Fatal("a 60KB room name should be rejected")
	}
}

// TestManyLongRoomJoinsRetainNothing is the end-to-end shape of probeC2:
// even if something upstream of validRoomName let a spray of long names
// through, join+leave+sweep must not retain them. Names are kept under
// MaxRoomNameBytes here since that's what a real client can actually get
// past the server-side gate now; the gate itself is covered above.
func TestManyLongRoomJoinsRetainNothing(t *testing.T) {
	clock := NewVirtualClock(1000.0)
	rel := NewRelay(clock, InertRoster(), metrics.New())
	c := &lockedConn{agent: "spray", human: "S"}
	pad := strings.Repeat("x", MaxRoomNameBytes-10)

	const n = 500
	for i := 0; i < n; i++ {
		if !rel.Join(fmt.Sprintf("%s-%d", pad, i), c) {
			t.Fatalf("join %d refused", i)
		}
	}
	rel.Leave(c)
	rel.registry.SweepAll()

	rel.roomsMu.RLock()
	nRelay := len(rel.rooms)
	rel.roomsMu.RUnlock()
	rel.registry.roomsMu.RLock()
	nReg := len(rel.registry.rooms)
	rel.registry.roomsMu.RUnlock()
	if nRelay != 0 || nReg != 0 {
		t.Fatalf("relay rooms=%d registry rooms=%d after leave+sweep, want 0/0", nRelay, nReg)
	}
}

// TestRoomsGaugeStillReadsZero is the invisibility control from the probe
// (TestProbeRoomsGaugeSaysZero): documents that ap_rooms only ever tracked
// membership, not allocation — this fix doesn't change that, it just makes
// sure allocation doesn't outlive membership either.
func TestRoomsGaugeStillReadsZero(t *testing.T) {
	clock := NewVirtualClock(1000.0)
	m := metrics.New()
	rel := NewRelay(clock, InertRoster(), m)
	c := &lockedConn{agent: "spray", human: "S"}
	for i := 0; i < 50; i++ {
		rel.Join(fmt.Sprintf("room-%d", i), c)
	}
	rel.Leave(c)
	rel.roomsMu.RLock()
	n := len(rel.rooms)
	rel.roomsMu.RUnlock()
	if n != 0 {
		t.Fatalf("expected the fix to also bring the room count itself to 0, got %d", n)
	}
}

// TestReapedShardIsDeadAndAcquireDoesNotReuseIt is a deterministic,
// single-threaded exercise of the exact mechanism
// TestReapRaceNeverGrantsIntoAReapedRoom hammers under real scheduling
// luck: a caller that resolved a shard *before* a reap must find it marked
// dead once it (re)inspects it, and the registry's own shard-resolving
// path must never hand that same shard back out afterward. Without this,
// the stress test's absence of a failure is weak evidence — the race
// window in real Go scheduling is a handful of instructions wide and can
// pass thousands of iterations clean even when the retry-on-dead check is
// missing entirely (verified by hand against a build with lockLiveShard
// reverted to plain shardFor: the stress test still passed). This test
// doesn't depend on winning that race; it inspects the state the race
// produces directly.
func TestReapedShardIsDeadAndAcquireDoesNotReuseIt(t *testing.T) {
	clock := NewVirtualClock(1000.0)
	pub := &fakePublisher{}
	reg := NewRegistry(clock, pub, metrics.New())
	const room = "detroom"
	const path = "src/x.go"

	// Resolve the shard the way Acquire's roomOf/shardFor would, before
	// anything has ever claimed anything in this room — simulating a
	// caller that has the shard pointer in hand right before a concurrent
	// reap runs.
	rs := reg.roomOf(room)
	s := rs.shards[fnv32(path)%shardsPerRoom]
	if s.dead {
		t.Fatal("a freshly created shard should not start dead")
	}

	// The room is genuinely empty (nothing has claimed anything), so one
	// sweep reaps it — deterministic, no goroutines needed.
	reg.SweepAll()

	reg.roomsMu.RLock()
	_, stillPresent := reg.rooms[room]
	reg.roomsMu.RUnlock()
	if stillPresent {
		t.Fatal("expected the empty room to be reaped by SweepAll")
	}

	// The stale shard reference the "straggler" caller was holding must
	// now read dead — this is the check lockLiveShard makes under the
	// same mu a straggler is forced to wait on.
	s.mu.Lock()
	dead := s.dead
	s.mu.Unlock()
	if !dead {
		t.Fatal("a shard belonging to a reaped room must be marked dead")
	}

	// The registry's own resolver must never hand the dead shard back
	// out — a fresh Acquire for the same room/path must get a new,
	// live shard, not the orphaned one.
	fresh := reg.lockLiveShard(room, path)
	fresh.mu.Unlock()
	if fresh == s {
		t.Fatal("lockLiveShard returned the reaped, dead shard instead of re-resolving")
	}

	// And the ordinary public path grants cleanly against the
	// recreated room, proving the retry doesn't just avoid the dead
	// shard but actually lands somewhere usable.
	res := reg.Acquire(room, "human", "agent", Region{Path: path}, "work", nil, PriorityNormal, nil)
	if !res.Ok {
		t.Fatalf("expected Acquire to grant cleanly in the recreated room, got %+v", res)
	}
}

// TestReapRaceNeverGrantsIntoAReapedRoom is the crux test: many goroutines
// hammer Acquire/Contend/Release on one room while a reaper hammers
// SweepAll concurrently, under -race. The bug this guards against is the
// #100 class the issue calls out by name: SweepAll deletes a room between
// a caller's roomOf lookup and that caller taking the shard's own lock,
// so the caller's grant lands in a shard nothing will ever read again —
// and because room lookups always go back through the map, a *second*
// Acquire for the same region can then land in a freshly recreated,
// empty-looking room and be granted too. Two live grants for one region at
// once is the failure mode: holders never exceeding 1 at a time is the
// assertion.
func TestReapRaceNeverGrantsIntoAReapedRoom(t *testing.T) {
	clock := RealClock{}
	pub := &fakePublisher{}
	reg := NewRegistry(clock, pub, metrics.New())
	const room = "hot-room"
	region := Region{Path: "src/hot.go"}

	var holders int32
	var doubleGrant int32

	stop := make(chan struct{})
	var reaperWg sync.WaitGroup
	reaperWg.Add(1)
	go func() {
		defer reaperWg.Done()
		for {
			select {
			case <-stop:
				return
			default:
				reg.SweepAll()
			}
		}
	}()

	const acquirers = 24
	const contenders = 8
	const opsEach = 400
	var wg sync.WaitGroup
	for g := 0; g < acquirers; g++ {
		wg.Add(1)
		go func(g int) {
			defer wg.Done()
			agent := fmt.Sprintf("acquirer-%d", g)
			for i := 0; i < opsEach; i++ {
				res := reg.Acquire(room, "human", agent, region, "work", nil, PriorityNormal, nil)
				if !res.Ok {
					if res.Decision == decisionAbort {
						reg.ReleaseAll(room, agent, nil)
					}
					continue
				}
				if atomic.AddInt32(&holders, 1) > 1 {
					atomic.StoreInt32(&doubleGrant, 1)
				}
				atomic.AddInt32(&holders, -1)
				reg.Release(room, agent, region, nil)
			}
		}(g)
	}
	// Separate goroutines exercising the plain Contend path (the "ask"
	// frame, not a grant attempt) against the same hot region, so the
	// reaper is also racing against contendLocked's mutation of whatever
	// claim it finds — Contend itself can never manufacture a claim into
	// a dead shard (it only ever mutates an existing held claim, and a
	// room reap requires no claims to be standing), but it should still
	// never panic or trip -race under the same hammer.
	for g := 0; g < contenders; g++ {
		wg.Add(1)
		go func(g int) {
			defer wg.Done()
			agent := fmt.Sprintf("contender-%d", g)
			for i := 0; i < opsEach; i++ {
				reg.Contend(room, region, agent, "human", PriorityNormal, nil, nil)
			}
		}(g)
	}
	wg.Wait()
	close(stop)
	reaperWg.Wait()

	if atomic.LoadInt32(&doubleGrant) != 0 {
		t.Fatal("two Acquire calls held the same region at once — a claim was granted into a reaped/orphaned shard")
	}

	claims := reg.ActiveClaims(room, nil)
	if len(claims) > 1 {
		t.Fatalf("room %s: %d live claims on one region after the hammer settled, want at most 1", room, len(claims))
	}
}
