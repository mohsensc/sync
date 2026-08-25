package relaysrv

import (
	"fmt"
	"testing"

	"github.com/mohsensc/sync/go/internal/metrics"
)

// Issue #167. An unauthenticated connection can join any room whose id it
// can derive (see docs/threat-model.md) and, until this, one frame from it
// capped a rostered principal's lease — 900s on the fair-share branch,
// 90s on the wait branch. It can still *ask*; it no longer decides when
// somebody else's lease ends.

// rosterWith builds an enforcing roster naming one principal per token.
func rosterWith(t *testing.T, entries map[string]string) Roster {
	t.Helper()
	text := "version = 1\ndefault_tier = \"normal\"\n"
	for id, token := range entries {
		text += fmt.Sprintf("\n[[principal]]\nid = %q\ntoken_sha256 = %q\nattended = \"critical\"\n",
			id, hashToken(token))
	}
	roster := ParseRoster(text, "<test>")
	if !roster.Enforcing() {
		t.Fatalf("test roster is not enforcing: %v", roster.Problems())
	}
	return roster
}

func regionOf(path string) Region { return Region{Path: path} }

func claimFrame(path string) map[string]any {
	return map[string]any{"type": "claim", "region": goldenRegion(path, ""), "intent": "work"}
}

func contendFrame(path string) map[string]any {
	return map[string]any{"type": "contend", "region": goldenRegion(path, "")}
}

// TestAnonymousContendDoesNotCapARosteredLease is the reported case: an
// anonymous normal-tier peer contends a rostered CRITICAL holder.
func TestAnonymousContendDoesNotCapARosteredLease(t *testing.T) {
	clock := NewVirtualClock(1000.0)
	reg := metrics.New()
	rel := NewRelay(clock, rosterWith(t, map[string]string{"alice": "s3cret"}), reg)

	holder := &recorder{agent: "holder", human: "H", principal: "alice", token: "s3cret"}
	anon := &recorder{agent: "anon", human: "A"}
	rel.Join("r1", holder)
	rel.Join("r1", anon)
	rel.Handle(holder, claimFrame("src/a.go"))

	clock.Advance(5)
	rel.Handle(anon, contendFrame("src/a.go"))

	h := rel.registry.HolderOf("r1", regionOf("src/a.go"), nil)
	if h == nil {
		t.Fatal("holder lost the lease to a contend, which is preemption")
	}
	if h.HandoverAt != nil {
		t.Fatalf("an unauthenticated ask capped the lease at %v; it should not arm a deadline", *h.HandoverAt)
	}
	// The ask is recorded even so — that is the half that must not change.
	if h.Waiting != 1 || h.Winner == nil || h.Winner.Agent != "anon" {
		t.Fatalf("the ask should still be recorded as a contender, got waiting=%d winner=%+v", h.Waiting, h.Winner)
	}
	if got := counterValue(t, reg, "ap_asks_unarmed_total"); got != 1 {
		t.Fatalf("ap_asks_unarmed_total = %v, want 1", got)
	}

	// The holder keeps the region right past where the old fair-share
	// deadline would have taken it.
	deadline := clock.Now() + FairShareGraceS
	for clock.Now() < deadline+HeartbeatS {
		clock.Advance(HeartbeatS)
		rel.Handle(holder, map[string]any{"type": "heartbeat", "region": goldenRegion("src/a.go", "")})
	}
	if rel.registry.HolderOf("r1", regionOf("src/a.go"), holder) == nil {
		t.Fatal("holder lost its lease past the suppressed fair-share deadline")
	}
	if r := rel.registry.ReservationFor("r1", regionOf("src/a.go"), nil); r != nil {
		t.Fatalf("region should not be reserved for an unauthenticated asker, got %+v", r)
	}
}

// TestAnonymousClaimDoesNotCapEither: no `contend` frame is needed — a
// plain claim that gets refused runs the same contendLocked path, and
// gating only Registry.Contend would have left this door open.
func TestAnonymousClaimDoesNotCapEither(t *testing.T) {
	clock := NewVirtualClock(1000.0)
	rel := NewRelay(clock, rosterWith(t, map[string]string{"alice": "s3cret"}), metrics.New())

	holder := &recorder{agent: "holder", human: "H", principal: "alice", token: "s3cret"}
	anon := &recorder{agent: "anon", human: "A"}
	rel.Join("r1", holder)
	rel.Join("r1", anon)
	rel.Handle(holder, claimFrame("src/a.go"))

	clock.Advance(5)
	rel.Handle(anon, claimFrame("src/a.go"))

	h := rel.registry.HolderOf("r1", regionOf("src/a.go"), nil)
	if h == nil || h.HandoverAt != nil {
		t.Fatalf("a refused claim from an unauthenticated peer armed a deadline: %+v", h)
	}
}

// TestAnonymousWaitBranchDoesNotCapEither is the sharper lever the issue
// didn't mention. wait-die orders on (-priority, acquired_at, agent), so an
// anonymous connection that has been around longer than a rostered
// *normal*-tier holder sorts below it and takes the `wait` branch — a 90s
// cap, not 900. The gate is on the deadline, not on the fair-share grace,
// precisely so this case is covered too.
func TestAnonymousWaitBranchDoesNotCapEither(t *testing.T) {
	clock := NewVirtualClock(1000.0)
	roster := ParseRoster("version = 1\ndefault_tier = \"normal\"\n\n"+
		"[[principal]]\nid = \"bob\"\ntoken_sha256 = \""+hashToken("hunter2")+"\"\nattended = \"normal\"\n",
		"<test>")
	if !roster.Enforcing() {
		t.Fatalf("roster not enforcing: %v", roster.Problems())
	}
	rel := NewRelay(clock, roster, metrics.New())

	// The anon connects (and so ages) first; the rostered holder arrives
	// later and claims. Same tier, older asker => decisionWait.
	anon := &recorder{agent: "anon", human: "A"}
	rel.Join("r1", anon)
	rel.Handle(anon, claimFrame("src/other.go"))

	clock.Advance(60)
	holder := &recorder{agent: "holder", human: "H", principal: "bob", token: "hunter2"}
	rel.Join("r1", holder)
	rel.Handle(holder, claimFrame("src/a.go"))

	clock.Advance(5)
	held := rel.registry.HolderOf("r1", regionOf("src/a.go"), nil)
	if decision := resolveWaitDie("anon", rel.registry.ageOf("anon"), &Claim{
		Agent: held.Agent, Priority: held.Priority, AcquiredAt: held.AcquiredAt,
	}, rel.priorityOf(anon)); decision != decisionWait {
		t.Fatalf("this test only means something on the wait branch, got %q", decision)
	}

	rel.Handle(anon, contendFrame("src/a.go"))
	h := rel.registry.HolderOf("r1", regionOf("src/a.go"), nil)
	if h == nil || h.HandoverAt != nil {
		t.Fatalf("the wait branch armed a 90s deadline for an unauthenticated asker: %+v", h)
	}
}

// TestAuthenticatedContendStillCaps: the anti-starvation bound is the
// point of the deadline (policy-design.md §5.2). A rostered principal
// still gets it.
func TestAuthenticatedContendStillCaps(t *testing.T) {
	clock := NewVirtualClock(1000.0)
	reg := metrics.New()
	rel := NewRelay(clock, rosterWith(t, map[string]string{"alice": "s3cret", "bob": "hunter2"}), reg)

	holder := &recorder{agent: "holder", human: "H", principal: "alice", token: "s3cret"}
	asker := &recorder{agent: "asker", human: "B", principal: "bob", token: "hunter2"}
	rel.Join("r1", holder)
	rel.Join("r1", asker)
	rel.Handle(holder, claimFrame("src/a.go"))

	clock.Advance(5)
	rel.Handle(asker, contendFrame("src/a.go"))

	h := rel.registry.HolderOf("r1", regionOf("src/a.go"), nil)
	if h == nil || h.HandoverAt == nil {
		t.Fatalf("a rostered principal's ask must still cap the holder, got %+v", h)
	}
	if got := counterValue(t, reg, "ap_asks_unarmed_total"); got != 0 {
		t.Fatalf("ap_asks_unarmed_total = %v, want 0 for an authenticated ask", got)
	}
}

// TestBadTokenIsUnauthenticated: presenting a name with the wrong token is
// not authentication. Roster.Authenticate deliberately doesn't refuse the
// join for it (losing a rung is the punishment), so the gate has to read
// the latched Grant rather than the name off the join frame.
func TestBadTokenIsUnauthenticated(t *testing.T) {
	clock := NewVirtualClock(1000.0)
	rel := NewRelay(clock, rosterWith(t, map[string]string{"alice": "s3cret", "bob": "hunter2"}), metrics.New())

	holder := &recorder{agent: "holder", human: "H", principal: "alice", token: "s3cret"}
	liar := &recorder{agent: "liar", human: "L", principal: "bob", token: "wrong"}
	rel.Join("r1", holder)
	rel.Join("r1", liar)
	rel.Handle(holder, claimFrame("src/a.go"))

	clock.Advance(5)
	rel.Handle(liar, contendFrame("src/a.go"))

	h := rel.registry.HolderOf("r1", regionOf("src/a.go"), nil)
	if h == nil || h.HandoverAt != nil {
		t.Fatalf("a name with the wrong token armed a deadline: %+v", h)
	}
}

// TestZeroConfigRoomKeepsTheDeadline: with no roster, everybody is
// unauthenticated, so gating on authentication alone would delete the
// anti-starvation bound for the case it exists to serve.
func TestZeroConfigRoomKeepsTheDeadline(t *testing.T) {
	clock := NewVirtualClock(1000.0)
	rel := NewRelay(clock, InertRoster(), metrics.New())

	holder := &recorder{agent: "holder", human: "H"}
	asker := &recorder{agent: "asker", human: "A"}
	rel.Join("r1", holder)
	rel.Join("r1", asker)
	rel.Handle(holder, claimFrame("src/a.go"))

	clock.Advance(5)
	rel.Handle(asker, contendFrame("src/a.go"))

	h := rel.registry.HolderOf("r1", regionOf("src/a.go"), nil)
	if h == nil || h.HandoverAt == nil {
		t.Fatalf("a room with no roster must keep the fair-share bound, got %+v", h)
	}
}

// TestBrokenRosterIsNotAGate: a principals.toml that parses to zero usable
// principals is present but not enforcing. Gating on Present() alone would
// mean a typo this morning silently removed the bound for everyone in the
// room, which is the worst possible way to learn about a typo.
func TestBrokenRosterIsNotAGate(t *testing.T) {
	for name, text := range map[string]string{
		"unparseable": "this is not toml {{{",
		"no usable principals": "version = 1\n\n[[principal]]\nid = \"alice\"\n" +
			"token_sha256 = \"not-a-sha\"\n",
	} {
		t.Run(name, func(t *testing.T) {
			roster := ParseRoster(text, "<test>")
			if !roster.Present() {
				t.Fatal("this case is only interesting while the roster is present")
			}
			if roster.Enforcing() {
				t.Fatal("a roster with no usable principals must not be enforcing")
			}

			clock := NewVirtualClock(1000.0)
			rel := NewRelay(clock, roster, metrics.New())
			holder := &recorder{agent: "holder", human: "H"}
			asker := &recorder{agent: "asker", human: "A"}
			rel.Join("r1", holder)
			rel.Join("r1", asker)
			rel.Handle(holder, claimFrame("src/a.go"))
			clock.Advance(5)
			rel.Handle(asker, contendFrame("src/a.go"))

			h := rel.registry.HolderOf("r1", regionOf("src/a.go"), nil)
			if h == nil || h.HandoverAt == nil {
				t.Fatalf("a broken roster must not remove the bound, got %+v", h)
			}
		})
	}
}

// TestUnarmedAskLeavesTheRegionFreeOnPlainExpiry: with nothing armed,
// there is no deadline for handOver to reserve against, so the lease just
// lapses and the region goes free. The ask being "recorded" is about the
// ordering and about the holder being able to see it — not a promise of
// the region.
//
// The clock has to run past where the fair-share deadline *would* have
// been, not merely past the lease's own TTL: handOver only reserves when
// HandoverAt has actually passed (`*c.HandoverAt > now` takes the carry
// branch), so a sweep at TTL+1 produces no reservation whether the ask
// armed or not, and the test would pass on pre-fix code.
func TestUnarmedAskLeavesTheRegionFreeOnPlainExpiry(t *testing.T) {
	clock := NewVirtualClock(1000.0)
	rel := NewRelay(clock, rosterWith(t, map[string]string{"alice": "s3cret"}), metrics.New())

	holder := &recorder{agent: "holder", human: "H", principal: "alice", token: "s3cret"}
	anon := &recorder{agent: "anon", human: "A"}
	rel.Join("r1", holder)
	rel.Join("r1", anon)
	rel.Handle(holder, claimFrame("src/a.go"))

	clock.Advance(5)
	rel.Handle(anon, contendFrame("src/a.go"))

	// The holder walks away without releasing. Sweep well past both the
	// lease TTL and the deadline the ask would have set.
	clock.Advance(FairShareGraceS + 1)
	rel.registry.SweepAll()

	if res := rel.registry.ReservationFor("r1", regionOf("src/a.go"), nil); res != nil {
		t.Fatalf("nothing armed, so nothing should be reserved, got %+v", res)
	}
	if h := rel.registry.HolderOf("r1", regionOf("src/a.go"), nil); h != nil {
		t.Fatalf("the lease should have lapsed, still held by %+v", h)
	}
}

// TestUnarmedAskCanStillRideAnAuthenticatedDeadline is the residual lever
// this change deliberately leaves open, pinned so it changes on purpose
// rather than by accident. An unauthenticated ask cannot cap a lease, but
// it stays in the handover order — so when a rostered principal's ask does
// arm the deadline, the winner is still whoever sorts first, which can be
// the unauthenticated one. Written down in docs/threat-model.md.
func TestUnarmedAskCanStillRideAnAuthenticatedDeadline(t *testing.T) {
	clock := NewVirtualClock(1000.0)
	// bob is normal-tier, the same tier the roster hands an anonymous
	// joiner, so the contender order comes down to who asked first.
	roster := ParseRoster("version = 1\ndefault_tier = \"normal\"\n\n"+
		"[[principal]]\nid = \"alice\"\ntoken_sha256 = \""+hashToken("s3cret")+"\"\nattended = \"critical\"\n\n"+
		"[[principal]]\nid = \"bob\"\ntoken_sha256 = \""+hashToken("hunter2")+"\"\nattended = \"normal\"\n",
		"<test>")
	if !roster.Enforcing() {
		t.Fatalf("roster not enforcing: %v", roster.Problems())
	}
	rel := NewRelay(clock, roster, metrics.New())

	anon := &recorder{agent: "anon", human: "A"}
	rel.Join("r1", anon)

	holder := &recorder{agent: "holder", human: "H", principal: "alice", token: "s3cret"}
	rel.Join("r1", holder)
	rel.Handle(holder, claimFrame("src/a.go"))

	clock.Advance(5)
	rel.Handle(anon, contendFrame("src/a.go"))
	if h := rel.registry.HolderOf("r1", regionOf("src/a.go"), nil); h.HandoverAt != nil {
		t.Fatalf("the anonymous ask armed a deadline: %v", *h.HandoverAt)
	}

	// bob asks later, and bob is rostered, so bob's ask does arm one.
	clock.Advance(30)
	bob := &recorder{agent: "bob-agent", human: "B", principal: "bob", token: "hunter2"}
	rel.Join("r1", bob)
	rel.Handle(bob, contendFrame("src/a.go"))
	h := rel.registry.HolderOf("r1", regionOf("src/a.go"), nil)
	if h.HandoverAt == nil {
		t.Fatal("a rostered ask must still arm the deadline")
	}
	if h.Winner == nil || h.Winner.Agent != "anon" {
		t.Fatalf("winner should still be the oldest contender, got %+v", h.Winner)
	}

	// The holder heartbeats right up to the deadline bob's ask set, which
	// is the case that ends in a handover rather than a plain expiry.
	deadline := *h.HandoverAt
	for clock.Now() < deadline {
		clock.Advance(HeartbeatS)
		rel.Handle(holder, map[string]any{"type": "heartbeat", "region": goldenRegion("src/a.go", "")})
	}
	clock.Advance(1)
	rel.registry.SweepAll()

	res := rel.registry.ReservationFor("r1", regionOf("src/a.go"), nil)
	if res == nil || res.Agent != "anon" {
		t.Fatalf("the handover still goes to the first in the order, got %+v", res)
	}
}
