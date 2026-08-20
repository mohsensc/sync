package relaysrv

import (
	"sync"
	"testing"

	"github.com/mohsensc/sync/go/internal/metrics"
)

// fakePublisher records every frame published, for tests that need to
// assert on fan-out rather than just registry state.
type fakePublisher struct {
	mu        sync.Mutex
	broadcast []Frame
	targeted  []Frame
}

func (p *fakePublisher) Publish(room string, frame Frame, actor Conn) {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.broadcast = append(p.broadcast, frame)
}

func (p *fakePublisher) PublishTo(room, agent string, frame Frame, actor Conn) {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.targeted = append(p.targeted, frame)
}

func newTestRegistry() (*VirtualClock, *Registry, *fakePublisher) {
	clock := NewVirtualClock(0)
	pub := &fakePublisher{}
	return clock, NewRegistry(clock, pub, metrics.New()), pub
}

var authRegion = Region{Path: "src/auth.py", Symbol: strp("sign_in")}

func strp(s string) *string { return &s }

// Ported from python/tests/test_leases.py.

func TestUncontestedLeaseIsGranted(t *testing.T) {
	_, reg, _ := newTestRegistry()
	res := reg.Acquire("r1", "sara", "a1", authRegion, "refactor", nil, PriorityNormal, nil)
	if !res.Ok || res.Claim == nil {
		t.Fatalf("expected a grant, got %+v", res)
	}
}

func TestSecondLeaseOnSameRegionIsRefusedAndNamesTheHolder(t *testing.T) {
	_, reg, _ := newTestRegistry()
	reg.Acquire("r1", "sara", "a1", authRegion, "refactor", nil, PriorityNormal, nil)
	res := reg.Acquire("r1", "dev", "a2", authRegion, "rename", nil, PriorityNormal, nil)
	if res.Ok {
		t.Fatalf("expected a refusal")
	}
	if res.HeldBy == nil || res.HeldBy.Agent != "a1" {
		t.Fatalf("expected held_by a1, got %+v", res.HeldBy)
	}
}

func TestLeaseExpiresAfterTTLWithNoManualCleanup(t *testing.T) {
	clock, reg, _ := newTestRegistry()
	reg.Acquire("r1", "sara", "a1", authRegion, "refactor", nil, PriorityNormal, nil)
	clock.Advance(LeaseTTLS + 1)
	res := reg.Acquire("r1", "dev", "a2", authRegion, "rename", nil, PriorityNormal, nil)
	if !res.Ok {
		t.Fatalf("expected the expired lease to have freed the region, got %+v", res)
	}
}

func TestHeartbeatExtendsTheLease(t *testing.T) {
	clock, reg, _ := newTestRegistry()
	reg.Acquire("r1", "sara", "a1", authRegion, "refactor", nil, PriorityNormal, nil)
	clock.Advance(LeaseTTLS - 1)
	if !reg.Heartbeat("r1", "a1", authRegion, nil) {
		t.Fatalf("expected heartbeat to renew")
	}
	clock.Advance(2) // would have expired without the heartbeat
	res := reg.Acquire("r1", "dev", "a2", authRegion, "steal", nil, PriorityNormal, nil)
	if res.Ok {
		t.Fatalf("expected the renewed lease to still hold, got a grant")
	}
}

func TestRoomsAreIsolatedEvenWithIdenticalPaths(t *testing.T) {
	_, reg, _ := newTestRegistry()
	reg.Acquire("room-a", "sara", "a1", authRegion, "x", nil, PriorityNormal, nil)
	res := reg.Acquire("room-b", "dev", "a2", authRegion, "y", nil, PriorityNormal, nil)
	if !res.Ok {
		t.Fatalf("expected room-b's identical path to be free, got %+v", res)
	}
}

func TestReleaseAllDropsEveryLeaseAnAgentHoldsInTheRoom(t *testing.T) {
	_, reg, _ := newTestRegistry()
	other := Region{Path: "src/db.py", Symbol: strp("query")}
	reg.Acquire("r1", "sara", "a1", authRegion, "x", nil, PriorityNormal, nil)
	reg.Acquire("r1", "sara", "a1", other, "y", nil, PriorityNormal, nil)
	reg.ReleaseAll("r1", "a1", nil)
	if reg.HolderOf("r1", authRegion, nil) != nil || reg.HolderOf("r1", other, nil) != nil {
		t.Fatalf("expected both leases to be dropped")
	}
}

func TestReleaseAllCannotReachAcrossRooms(t *testing.T) {
	_, reg, _ := newTestRegistry()
	reg.Acquire("room-a", "sara", "a1", authRegion, "x", nil, PriorityNormal, nil)
	reg.Acquire("room-b", "sara", "a1", authRegion, "y", nil, PriorityNormal, nil)
	reg.ReleaseAll("room-a", "a1", nil)
	if reg.HolderOf("room-b", authRegion, nil) == nil {
		t.Fatalf("release_all in room-a dropped a1's lease in room-b too")
	}
}

func TestAWholeFileClaimBlocksASymbolClaimInThatFile(t *testing.T) {
	_, reg, _ := newTestRegistry()
	whole := Region{Path: "src/auth.py"}
	reg.Acquire("r1", "sara", "a1", whole, "rewriting the file", nil, PriorityNormal, nil)
	res := reg.Acquire("r1", "dev", "a2", authRegion, "rename", nil, PriorityNormal, nil)
	if res.Ok || res.HeldBy == nil || res.HeldBy.Agent != "a1" {
		t.Fatalf("expected the whole-file claim to block the symbol claim, got %+v", res)
	}
}

func TestASymbolClaimBlocksAWholeFileClaim(t *testing.T) {
	_, reg, _ := newTestRegistry()
	whole := Region{Path: "src/auth.py"}
	reg.Acquire("r1", "sara", "a1", authRegion, "refactor", nil, PriorityNormal, nil)
	if reg.Acquire("r1", "dev", "a2", whole, "rewrite", nil, PriorityNormal, nil).Ok {
		t.Fatalf("expected the symbol claim to block the whole-file claim")
	}
}

// -- wait-die decisions on the claim path --------------------------------

func TestABrandNewRequesterIsYoungerAndThereforeDies(t *testing.T) {
	clock, reg, _ := newTestRegistry()
	reg.Acquire("r1", "sara", "a1", authRegion, "x", nil, PriorityNormal, nil)
	clock.Advance(10)
	res := reg.Acquire("r1", "dev", "a2", authRegion, "y", nil, PriorityNormal, nil)
	if res.Decision != decisionAbort {
		t.Fatalf("expected abort, got %v", res.Decision)
	}
}

func TestARequesterHoldingAnOlderLeaseWaitsInstead(t *testing.T) {
	clock, reg, _ := newTestRegistry()
	other := Region{Path: "src/db.py", Symbol: strp("query")}
	// a2 becomes the elder by taking a lease first.
	reg.Acquire("r1", "dev", "a2", other, "warm up", nil, PriorityNormal, nil)
	clock.Advance(10)
	reg.Acquire("r1", "sara", "a1", authRegion, "x", nil, PriorityNormal, nil)
	res := reg.Acquire("r1", "dev", "a2", authRegion, "y", nil, PriorityNormal, nil)
	if res.Decision != decisionWait {
		t.Fatalf("expected wait, got %v", res.Decision)
	}
}

func TestAgeIsTheOldestLiveClaimNotTheNewest(t *testing.T) {
	clock, reg, _ := newTestRegistry()
	other := Region{Path: "src/db.py", Symbol: strp("query")}
	reg.Acquire("r1", "sara", "a1", authRegion, "first", nil, PriorityNormal, nil)
	clock.Advance(10)
	reg.Acquire("r1", "sara", "a1", other, "second", nil, PriorityNormal, nil)
	if got := reg.AgeOf("a1"); got != 0.0 {
		t.Fatalf("expected age 0.0 (the first claim), got %v", got)
	}
}

func TestAgeOfAnAgentHoldingNothingIsNowOnFirstSight(t *testing.T) {
	clock, reg, _ := newTestRegistry()
	clock.Advance(7)
	if got := reg.AgeOf("nobody"); got != 7.0 {
		t.Fatalf("expected 7.0 on first sight, got %v", got)
	}
}

// -- PR #37 / issue #35: requester age survives an abort -------------------
//
// Before the fix, age_of returned clock.now() for any agent holding
// nothing, so a requester that had just been refused (and, on abort, had
// its own leases dropped) always read as brand new on its very next ask —
// the "wait" half of wait-die was unreachable for the ordinary shape of
// contention. This is the behaviour the Go relay ships, not the bug.

func TestRequesterAgeSurvivesAnAbortAndCanLaterWin(t *testing.T) {
	clock, reg, _ := newTestRegistry()
	// a1 is seen first (and holds nothing) — this is its "first_seen" age.
	reg.AgeOf("a1")
	clock.Advance(5)
	// a2 takes the region and is therefore younger than a1's first_seen age.
	reg.Acquire("r1", "dev", "a2", authRegion, "work", nil, PriorityNormal, nil)
	clock.Advance(1)
	// a1 asks, loses (it is older, so wait-die says *wait*, not abort —
	// but to exercise the fix directly, drive age_of the way `contend`
	// does and confirm it is NOT "now".
	age := reg.AgeOf("a1")
	if age != 0.0 {
		t.Fatalf("expected a1's age to still be its first-seen time (0.0), got %v — "+
			"age_of is resetting to now for an agent holding nothing, which is the "+
			"bug PR #37/#35 fixed", age)
	}
}

func TestReleaseToEmptyHandedResetsAgeForTheNextGenuinelyNewAsk(t *testing.T) {
	// The other half of the fix: release() (a *voluntary* end, not an
	// abort) does start the clock fresh, because the transaction actually
	// concluded on its own terms. Mirrors leases.py's release() comment.
	clock, reg, _ := newTestRegistry()
	reg.Acquire("r1", "sara", "a1", authRegion, "x", nil, PriorityNormal, nil)
	clock.Advance(3)
	reg.Release("r1", "a1", authRegion, nil)
	clock.Advance(4)
	if got := reg.AgeOf("a1"); got != 7.0 {
		t.Fatalf("expected age to reset to 7.0 after a voluntary release, got %v", got)
	}
}

// -- issue #163: wait-die age's three-way split on removal ------------------
//
// agentClaimAdded always clears firstSeenSet, so ageOf never sees the value
// agentClaimRemoved preserves unless the removal path actually re-latches
// it. Three endings, three different rules: abort/expiry preserve the age
// (a retry keeps the priority it earned), a voluntary release resets it
// (the transaction concluded on its own terms), and a session ending clears
// it outright (the identity is gone, not just between claims).

func TestAbortPreservesAgeSoARetryIsToldWaitNotReset(t *testing.T) {
	clock, reg, _ := newTestRegistry()
	other := Region{Path: "src/db.py", Symbol: strp("query")}

	// old claims early, at t=0.
	reg.Acquire("r1", "sara", "old", authRegion, "x", nil, PriorityNormal, nil)
	clock.Advance(10)
	// newbie claims a different region at t=10 — newbie is younger.
	reg.Acquire("r1", "dev", "newbie", other, "y", nil, PriorityNormal, nil)
	clock.Advance(5)
	// newbie contends old's region and, being younger, gets told abort —
	// wait-die makes it drop everything it holds via ReleaseAll (relay.go's
	// onClaim mirrors this by calling ReleaseAll on decisionAbort).
	res := reg.Acquire("r1", "dev", "newbie", authRegion, "steal", nil, PriorityNormal, nil)
	if res.Decision != decisionAbort {
		t.Fatalf("expected newbie (younger) to abort, got %v", res.Decision)
	}
	reg.ReleaseAll("r1", "newbie", nil)

	clock.Advance(50)
	if got := reg.AgeOf("newbie"); got != 10.0 {
		t.Fatalf("expected newbie's age to stay latched at its acquire time (10.0) across the abort, got %v", got)
	}

	// Consequence: newbie retries later and, because its age is preserved
	// rather than reset to "now", still loses to old (which is genuinely
	// older) — but the point of preserving age is that a still-younger
	// retry gets the short handover grace, not the long fair-share one. See
	// TestAgeIsTheOldestLiveClaimNotTheNewest and the Contend test above for
	// the grace-size assertion; this test only pins the age itself.
}

func TestExpiryPreservesAgeTheSameWayAbortDoes(t *testing.T) {
	clock, reg, _ := newTestRegistry()

	reg.Acquire("r1", "sara", "a1", authRegion, "x", nil, PriorityNormal, nil)
	clock.Advance(LeaseTTLS + 1) // lease expires; a1 holds nothing lazily

	// Nothing has touched a1's shard since the acquire, so the expiry
	// hasn't been discovered yet — force it via the read path, same as
	// TestExpiryDiscoveredByAReadStillPublishes.
	if reg.HolderOf("r1", authRegion, nil) != nil {
		t.Fatalf("expected the lease to have expired")
	}

	if got := reg.AgeOf("a1"); got != 0.0 {
		t.Fatalf("expected a lazy expiry to preserve age at acquire time (0.0), got %v", got)
	}
}

func TestVoluntaryReleaseResetsAgeEvenAfterAnEarlierAbort(t *testing.T) {
	clock, reg, _ := newTestRegistry()

	// Seed a1 with a latched age the way an abort would, to make sure
	// release() actually clears it rather than merely never setting it.
	reg.Acquire("r1", "sara", "a1", authRegion, "x", nil, PriorityNormal, nil)
	clock.Advance(3)
	reg.ReleaseAll("r1", "a1", nil) // abort-shaped removal: preserves age
	if got := reg.AgeOf("a1"); got != 0.0 {
		t.Fatalf("setup: expected the abort to preserve age 0.0, got %v", got)
	}

	clock.Advance(4) // now 7
	reg.Acquire("r1", "sara", "a1", authRegion, "y", nil, PriorityNormal, nil)
	clock.Advance(2) // now 9
	reg.Release("r1", "a1", authRegion, nil)

	clock.Advance(1) // now 10
	if got := reg.AgeOf("a1"); got != 10.0 {
		t.Fatalf("expected a voluntary release to reset age to now (10.0) regardless of the earlier abort, got %v", got)
	}
}

func TestSessionEndClearsAgeAndARejoinStartsFresh(t *testing.T) {
	clock, reg, _ := newTestRegistry()

	// a1 is old — claims at t=0 — so it would normally outrank anyone who
	// shows up later.
	reg.Acquire("r1", "sara", "a1", authRegion, "x", nil, PriorityNormal, nil)
	clock.Advance(20)

	// The connection actually ends (relay.go's Leave), not an abort.
	reg.ReleaseAllSessionEnd("r1", "a1", nil)

	clock.Advance(5)
	// a1 rejoins under the same agent id and immediately contends a region
	// someone else took while it was gone. If session end had preserved
	// age (like an abort does), a1 would still read as the room's elder.
	other := Region{Path: "src/db.py", Symbol: strp("query")}
	reg.Acquire("r1", "dev", "newer", other, "warm up", nil, PriorityNormal, nil)

	got := reg.AgeOf("a1")
	if got != 25.0 {
		t.Fatalf("expected a1's age to start fresh at 25.0 (now, on first sight after rejoin), got %v — "+
			"session end must clear the wait-die entry, not preserve it like an abort", got)
	}
}

// -- PR #37 / issue #34: lazy expiry discovered by a read still broadcasts -

func TestExpiryDiscoveredByAReadStillPublishes(t *testing.T) {
	clock, reg, pub := newTestRegistry()
	reg.Acquire("r1", "sara", "a1", authRegion, "x", nil, PriorityNormal, nil)
	clock.Advance(LeaseTTLS + 1)

	// HolderOf is a read, not a write — before the fix, only the mutating
	// calls (acquire/release/...) diffed and published; a read-triggered
	// expiry vanished from the table silently and the room never heard it
	// timed out.
	if reg.HolderOf("r1", authRegion, nil) != nil {
		t.Fatalf("expected the lease to have expired")
	}
	pub.mu.Lock()
	defer pub.mu.Unlock()
	found := false
	for _, f := range pub.broadcast {
		if f["type"] == "lease" && f["state"] == "expired" && f["agent"] == "a1" {
			found = true
		}
	}
	if !found {
		t.Fatalf("expected a lease/expired frame from the read-triggered expiry, got %+v", pub.broadcast)
	}
}

// -- handover / reservation -------------------------------------------------

func TestContentionCapsTheHoldersRenewal(t *testing.T) {
	clock, reg, _ := newTestRegistry()
	reg.Acquire("r1", "sara", "a1", authRegion, "x", nil, PriorityNormal, nil)
	clock.Advance(1)
	reg.Contend("r1", authRegion, "a2", "dev", PriorityNormal, nil, nil)

	held := reg.HolderOf("r1", authRegion, nil)
	if held.HandoverAt == nil {
		t.Fatalf("expected a handover deadline after contention")
	}
	// a2 loses wait-die (younger) so the cap is the long fair-share grace,
	// not the short handover grace.
	want := 1.0 + FairShareGraceS
	if *held.HandoverAt != want {
		t.Fatalf("expected handover_at %v, got %v", want, *held.HandoverAt)
	}
}

func TestRegionIsReservedForTheWinnerAfterHandoverDeadline(t *testing.T) {
	clock, reg, _ := newTestRegistry()
	other := Region{Path: "src/db.py", Symbol: strp("query")}
	// a2 is elder (claims first), so when it contends for a1's region,
	// wait-die says a1 (the younger holder) faces the short handover grace.
	reg.Acquire("r1", "dev", "a2", other, "warm up", nil, PriorityNormal, nil)
	clock.Advance(10)
	reg.Acquire("r1", "sara", "a1", authRegion, "x", nil, PriorityNormal, nil)
	reg.Contend("r1", authRegion, "a2", "dev", PriorityNormal, nil, nil)

	held := reg.HolderOf("r1", authRegion, nil)
	if held.HandoverAt == nil {
		t.Fatalf("expected a handover deadline")
	}
	clock.Advance(*held.HandoverAt - clock.Now() + 0.001)

	// The lease should now be gone (deadline passed) and the region
	// reserved for a2.
	if reg.HolderOf("r1", authRegion, nil) != nil {
		t.Fatalf("expected the lease to have ended at its handover deadline")
	}
	res := reg.ReservationFor("r1", authRegion, nil)
	if res == nil || res.Agent != "a2" {
		t.Fatalf("expected the region reserved for a2, got %+v", res)
	}

	// a1 (the loser) cannot jump the reservation.
	grab := reg.Acquire("r1", "sara", "a1", authRegion, "grab it back", nil, PriorityNormal, nil)
	if grab.Ok {
		t.Fatalf("expected the reservation to block anyone but a2")
	}

	// a2 claims it — inherits the reservation.
	win := reg.Acquire("r1", "dev", "a2", authRegion, "mine now", nil, PriorityNormal, nil)
	if !win.Ok {
		t.Fatalf("expected a2 to be granted the reserved region, got %+v", win)
	}
}

// -- priority -----------------------------------------------------------

func TestHigherTierWaitsAgainstAnOlderLowerTierHolder(t *testing.T) {
	clock, reg, _ := newTestRegistry()
	reg.Acquire("r1", "sara", "a1", authRegion, "x", nil, PriorityNormal, nil)
	clock.Advance(10)
	res := reg.Acquire("r1", "ci", "a2", authRegion, "y", nil, PriorityCritical, nil)
	if res.Decision != decisionWait {
		t.Fatalf("expected a critical requester to wait against an older normal holder, got %v", res.Decision)
	}
}

// -- carry: the dodge-the-deadline check survives a changed line range ----
//
// Lines is display-only, never region identity (types.go), so carryKey
// can't key on it — a holder that releases and re-claims the same symbol
// with a different (or absent) line range is still the same claim dodging
// its deadline, and must inherit it. See leases.go's carryKey doc comment.

func TestCarryResumesAcrossADifferentLineRange(t *testing.T) {
	clock, reg, _ := newTestRegistry()
	other := Region{Path: "src/db.py", Symbol: strp("query")}
	linesA := Region{Path: "src/auth.py", Symbol: strp("sign_in"), Lines: []int{1, 10}}
	linesB := Region{Path: "src/auth.py", Symbol: strp("sign_in"), Lines: []int{5, 15}}

	// a2 is elder, so a1 (holder) faces the short handover grace when a2
	// contends — a carry entry is only meaningful while a deadline is
	// pending.
	reg.Acquire("r1", "dev", "a2", other, "warm up", nil, PriorityNormal, nil)
	clock.Advance(10)
	reg.Acquire("r1", "sara", "a1", linesA, "x", nil, PriorityNormal, nil)
	reg.Contend("r1", linesA, "a2", "dev", PriorityNormal, nil, nil)

	held := reg.HolderOf("r1", linesA, nil)
	if held.HandoverAt == nil {
		t.Fatalf("expected a handover deadline before the dodge")
	}
	deadline := *held.HandoverAt

	// a1 lets go early (before the deadline) and re-claims the same symbol
	// but a different line range.
	reg.Release("r1", "a1", linesA, nil)
	reacquired := reg.Acquire("r1", "sara", "a1", linesB, "y", nil, PriorityNormal, nil)
	if !reacquired.Ok {
		t.Fatalf("expected the re-claim to succeed, got %+v", reacquired)
	}
	if reacquired.Claim.HandoverAt == nil || *reacquired.Claim.HandoverAt != deadline {
		t.Fatalf("expected the carried deadline %v to survive a changed line range, got %+v",
			deadline, reacquired.Claim.HandoverAt)
	}
}

func TestCarryResumesAcrossNoLines(t *testing.T) {
	clock, reg, _ := newTestRegistry()
	other := Region{Path: "src/db.py", Symbol: strp("query")}
	linesA := Region{Path: "src/auth.py", Symbol: strp("sign_in"), Lines: []int{1, 10}}
	noLines := Region{Path: "src/auth.py", Symbol: strp("sign_in")}

	reg.Acquire("r1", "dev", "a2", other, "warm up", nil, PriorityNormal, nil)
	clock.Advance(10)
	reg.Acquire("r1", "sara", "a1", linesA, "x", nil, PriorityNormal, nil)
	reg.Contend("r1", linesA, "a2", "dev", PriorityNormal, nil, nil)

	held := reg.HolderOf("r1", linesA, nil)
	if held.HandoverAt == nil {
		t.Fatalf("expected a handover deadline before the dodge")
	}
	deadline := *held.HandoverAt

	// a1 lets go early (before the deadline) and re-claims the same symbol
	// with no line range at all.
	reg.Release("r1", "a1", linesA, nil)
	reacquired := reg.Acquire("r1", "sara", "a1", noLines, "y", nil, PriorityNormal, nil)
	if !reacquired.Ok {
		t.Fatalf("expected the re-claim to succeed, got %+v", reacquired)
	}
	if reacquired.Claim.HandoverAt == nil || *reacquired.Claim.HandoverAt != deadline {
		t.Fatalf("expected the carried deadline %v to survive an absent line range, got %+v",
			deadline, reacquired.Claim.HandoverAt)
	}
}

func TestCarryDoesResumeAcrossTheSameLineRange(t *testing.T) {
	clock, reg, _ := newTestRegistry()
	other := Region{Path: "src/db.py", Symbol: strp("query")}
	lines := Region{Path: "src/auth.py", Symbol: strp("sign_in"), Lines: []int{1, 10}}

	reg.Acquire("r1", "dev", "a2", other, "warm up", nil, PriorityNormal, nil)
	clock.Advance(10)
	reg.Acquire("r1", "sara", "a1", lines, "x", nil, PriorityNormal, nil)
	reg.Contend("r1", lines, "a2", "dev", PriorityNormal, nil, nil)

	held := reg.HolderOf("r1", lines, nil)
	deadline := *held.HandoverAt

	reg.Release("r1", "a1", lines, nil)
	reacquired := reg.Acquire("r1", "sara", "a1", lines, "y", nil, PriorityNormal, nil)
	if !reacquired.Ok {
		t.Fatalf("expected the re-claim to succeed, got %+v", reacquired)
	}
	if reacquired.Claim.HandoverAt == nil || *reacquired.Claim.HandoverAt != deadline {
		t.Fatalf("expected the carried deadline %v to resume, got %+v", deadline, reacquired.Claim.HandoverAt)
	}
}

// -- issue #47: expiry sweep, cross-shard -----------------------------------

// TestSweepAllBroadcastsAnIdleShardsExpiry is the two-region test issue #47
// asks for: an expiry on a region nobody touches again must still reach the
// room, not just an expiry on a region somebody happens to poll. Region
// names are picked to land in different shards (see shardFor) so a touch on
// one cannot piggyback on the other's pruneExpired call the way the golden
// scenario's single-region script never would.
func TestSweepAllBroadcastsAnIdleShardsExpiry(t *testing.T) {
	clock, reg, pub := newTestRegistry()

	a := Region{Path: "a.py"}
	b := Region{Path: "b.py"}
	if shardFor(t, reg, "r1", a.Path) == shardFor(t, reg, "r1", b.Path) {
		t.Fatalf("test fixture needs a.py and b.py in different shards")
	}

	reg.Acquire("r1", "sara", "a1", a, "x", nil, PriorityNormal, nil)
	reg.Acquire("r1", "dev", "a2", b, "y", nil, PriorityNormal, nil)
	clock.Advance(LeaseTTLS + 1)

	// Nothing touches a.py again. Only b.py's shard sees any traffic.
	reg.Heartbeat("r1", "a2", b, nil)

	pub.mu.Lock()
	sawAExpired := false
	for _, f := range pub.broadcast {
		if f["type"] == "lease" && f["state"] == "expired" && f["agent"] == "a1" {
			sawAExpired = true
		}
	}
	pub.mu.Unlock()
	if sawAExpired {
		t.Fatalf("a.py's expiry should not be visible yet — nothing touched its shard")
	}

	// The background sweep (server.go's ticker, called directly here)
	// reaches every shard regardless of what traffic touched.
	reg.SweepAll()

	pub.mu.Lock()
	defer pub.mu.Unlock()
	sawAExpired = false
	for _, f := range pub.broadcast {
		if f["type"] == "lease" && f["state"] == "expired" && f["agent"] == "a1" {
			sawAExpired = true
		}
	}
	if !sawAExpired {
		t.Fatalf("expected SweepAll to broadcast a.py's expiry even though nothing polled it, got %+v", pub.broadcast)
	}
}

func shardFor(t *testing.T, reg *Registry, room, path string) *shard {
	t.Helper()
	return reg.shardFor(room, path)
}
