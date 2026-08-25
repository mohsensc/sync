package relaysrv

import (
	"testing"

	"github.com/mohsensc/sync/go/internal/metrics"
)

// bindAgent used to call Relay.Leave on another connection's Conn, from the
// evicting goroutine. Join holds no single lock for its whole body — a
// connection switching rooms sits between leaveAllRooms and
// SetRoom/joinRoom with nothing held — so an eviction landing in that
// window unwound state the target was in the middle of rebuilding, and the
// target came out the other side a working room member with no identity
// record: invisible to the next collision check, which is the one thing
// bindAgent exists to prevent.
//
// The fix is structural rather than a lock: eviction takes the transport
// down and the target's own session goroutine runs Leave, the way every
// other disconnect already does. So the test is structural too — it
// asserts bindAgent touches none of the target's relay-owned state, which
// holds under every interleaving rather than reproducing one of them. It
// needs no goroutines and fails deterministically against the old code.
func TestEvictionLeavesTheTargetsStateToItsOwnGoroutine(t *testing.T) {
	clock := NewVirtualClock(1000.0)
	reg := metrics.New()
	rel := NewRelay(clock, criticalRoster(), reg)

	// The unauthenticated holder of agent id "x".
	victim := &authConn{agent: "x", human: "V"}
	if !rel.Join("room1", victim) {
		t.Fatal("victim should join")
	}
	// Make it a daemon too, so the gauge is in play.
	rel.Handle(victim, map[string]any{"type": "stats", "outbound_dropped": 0})
	daemonsBefore := gaugeValue(t, reg, "ap_daemons_connected")

	// alice reclaims the same agent id, authenticated.
	claimant := &authConn{agent: "x", human: "A", principal: "alice", token: "s3cret"}
	if !rel.Join("room2", claimant) {
		t.Fatal("the authenticated claimant should join")
	}

	// The eviction is a transport close and nothing else.
	if len(victim.evictions) != 1 {
		t.Fatalf("expected exactly one Evict on the victim, got %v", victim.evictions)
	}
	if victim.evictions[0] == "" {
		t.Fatal("eviction should carry a reason for the client's log")
	}

	rel.identityMu.Lock()
	_, hasIdentity := rel.identity[victim]
	_, hasPrincipal := rel.principal[victim]
	rel.identityMu.Unlock()
	if !hasIdentity || !hasPrincipal {
		t.Fatalf("bindAgent unwound the victim's relay state behind its back: identity=%v principal=%v",
			hasIdentity, hasPrincipal)
	}
	if got := victim.Room(); got != "room1" {
		t.Fatalf("victim's room = %q, want room1 — bindAgent should not touch it", got)
	}
	if got := gaugeValue(t, reg, "ap_daemons_connected"); got != daemonsBefore {
		t.Fatalf("ap_daemons_connected moved to %v from %v; the victim's socket is still open, "+
			"so its own Leave has not run yet", got, daemonsBefore)
	}
}

// And the state does get unwound — once, when the victim's own session ends
// the way a closed socket makes it.
func TestVictimsOwnLeaveStillUnwindsEverything(t *testing.T) {
	clock := NewVirtualClock(1000.0)
	rel := NewRelay(clock, criticalRoster(), metrics.New())

	victim := &authConn{agent: "x", human: "V"}
	rel.Join("room1", victim)
	claimant := &authConn{agent: "x", human: "A", principal: "alice", token: "s3cret"}
	rel.Join("room2", claimant)

	// This is what server.go's `defer relay.Leave(conn)` runs when the
	// read loop notices the closed socket.
	rel.Leave(victim)

	rel.identityMu.Lock()
	_, hasIdentity := rel.identity[victim]
	_, hasPrincipal := rel.principal[victim]
	rel.identityMu.Unlock()
	if hasIdentity || hasPrincipal {
		t.Fatal("the victim's own Leave should clear its identity and principal")
	}
}

// An authenticated holder of the same id is refused outright, never
// evicted — the branch that makes the grace window safe.
func TestAuthenticatedHolderIsRefusedNotEvicted(t *testing.T) {
	clock := NewVirtualClock(1000.0)
	rel := NewRelay(clock, criticalRoster(), metrics.New())

	first := &authConn{agent: "x", human: "A", principal: "alice", token: "s3cret"}
	if !rel.Join("room1", first) {
		t.Fatal("first should join")
	}
	second := &authConn{agent: "x", human: "B"}
	if rel.Join("room2", second) {
		t.Fatal("an unauthenticated join should not take an authenticated principal's agent id")
	}
	if len(first.evictions) != 0 {
		t.Fatalf("an authenticated holder must never be evicted, got %v", first.evictions)
	}
}
