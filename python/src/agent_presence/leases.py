from __future__ import annotations

from dataclasses import dataclass

from .clock import Clock
from .priority import PRIORITY_NORMAL
from .types import Claim, Contender, Region, same_region
from .wait_die import Decision, OrderKey, order_key, resolve

LEASE_TTL_S = 90.0
PRESENCE_TTL_S = 30.0
HEARTBEAT_S = 30.0

# How long a holder keeps a region after somebody more entitled has asked for
# it. One TTL, so the sentence the docs and the hook have always said — "wait
# out at most 90 seconds and it is yours" — is finally true of a holder that is
# still working, not only of one that walked away.
HANDOVER_GRACE_S = 90.0

# The same cap for a contender that is *not* more entitled: the anti-starvation
# bound. Fifteen minutes is long enough that a senior agent finishes a real unit
# of work uninterrupted, and short enough that a junior agent behind it makes
# progress inside a coffee break instead of never.
FAIR_SHARE_GRACE_S = 900.0

# How long a region freed by a handover is kept for the contender it was freed
# for. Without this the fair-share cap is theatre: the region opens, the agent
# that has been renewing for fifteen minutes claims it again on its next
# heartbeat, and the loser is back where it started.
#
# Ten seconds, and it started at thirty. The winner is not waiting on a
# heartbeat — it was handed the deadline in the refusal it is sitting on and
# retries on its next tool call, which is milliseconds — so thirty seconds was
# slack for an agent that is there and a thirty second hole for one that is not.
# The hole is real and it is measurable: at thirty seconds the forty-agent
# contention run in tests/test_invariants.py lost 13% of its grants to regions
# nobody was in. Ten is still three orders of magnitude of slack for a live
# agent and a third of the cost for a departed one.
RESERVATION_S = 10.0

# How many carried deadlines are kept before the expired ones are swept. Sized
# so an ordinary room never reaches it: one entry per (region, agent) that let
# go of a contended lease early. See LeaseRegistry._hand_over.
_CARRY_MAX = 512


@dataclass(frozen=True)
class Reservation:
    """A region held open for the agent a handover freed it for."""

    room: str
    scope: Region
    agent: str
    human: str
    priority: int
    expires_at: float
    # Who was holding it. The relay puts this in the grant so the winner is told
    # it inherited the region rather than merely won a race for it.
    from_agent: str
    from_human: str


@dataclass
class AcquireResult:
    ok: bool
    claim: Claim | None = None
    held_by: Claim | None = None
    # Only set when ok is False: what wait-die says the requester should do.
    decision: Decision | None = None
    # Set when ok is False because somebody else's handover reserved the region.
    # `held_by` is None in that case: nobody holds it, it is being kept.
    reserved_by: Reservation | None = None
    # Set when ok is False and the requester will be handed the region: the
    # wall clock at which the holder's lease stops being renewable. This is the
    # number that makes a `wait` verdict actionable instead of open-ended.
    handover_at: float | None = None
    # Set when ok is True and this claim consumed a reservation left by a
    # handover, so the grant can say where the region came from.
    inherited: Reservation | None = None


class LeaseRegistry:
    """In-memory lease registry. The relay owns exactly one.

    Expiry is lazy — nothing is swept on a timer — so there is no code path in
    which a crashed process leaves behind a lease that outlives its TTL.

    Every per-lease operation is scoped by room. Two rooms may use identical
    paths and must never see each other's leases.

    Contention is bounded, and this is the part worth reading before changing
    anything here. An uncontended lease renews forever: an agent working alone
    is never interrupted, which is the whole point of the thing. The moment
    somebody else asks for the region, the holder's renewals stop being
    open-ended and get a deadline — ``HANDOVER_GRACE_S`` from the ask if the
    asker outranks it, ``FAIR_SHARE_GRACE_S`` if it does not. When the deadline
    passes the lease ends normally, on the same lazy expiry as everything else,
    and the region is kept for the waiting agent for ``RESERVATION_S``.

    So there are exactly three ways to wait here and all three are finite:

        holder is idle       -> LEASE_TTL_S
        holder is working    -> HANDOVER_GRACE_S  (you outrank it)
                             -> FAIR_SHARE_GRACE_S (you do not)
        region is reserved   -> RESERVATION_S

    No lease is ever revoked mid-edit and nothing is preempted; the holder is
    told its deadline while it still has time to finish. See ``_hand_over``.
    """

    def __init__(self, clock: Clock) -> None:
        self._clock = clock
        self._claims: list[Claim] = []
        self._reservations: list[Reservation] = []
        # (room, region, agent) -> who was first in the queue against that
        # agent's claim when it ended early, and the deadline that ask had set.
        # See `_hand_over` and `_resume_carry`.
        self._carry: dict[
            tuple[str, Region, str], tuple[Contender, float | None]
        ] = {}
        # agent -> the first moment `age_of` ever saw it holding nothing. See
        # `age_of` and `release_everywhere`.
        self._first_seen: dict[str, float] = {}

    def _live(self) -> list[Claim]:
        # One pass, and no allocation at all when nothing expired — which is
        # nearly always, and this is the most-called function in the relay.
        now = self._clock.now()
        claims = self._claims
        live = [c for c in claims if c.expires_at > now]
        if len(live) == len(claims):
            return claims
        self._claims = live
        for claim in claims:
            if claim.expires_at <= now:
                self._hand_over(claim, now)
        return live

    # -- handover -----------------------------------------------------------

    def _hand_over(self, claim: Claim, now: float) -> Reservation | None:
        """A claim has left the table. If its renewal deadline is what ended it,
        keep the region for the agent that was waiting.

        This is the half of the fair-share bound that makes it a bound. Capping
        renewal only frees the region; without a reservation the agent that has
        been renewing for fifteen minutes wins the re-claim race on its next
        heartbeat and the contender starves anyway, just noisily.

        Only a fired deadline reserves, and the narrowness is the point. A lease
        that ended some other way — released, finished, aborted, or gone quiet
        for a whole TTL — leaves the region open to whoever asks first, because
        in none of those cases is the holder being forced off and about to grab
        it back. Reserving there too puts a timer in front of every region
        anybody ever glanced at, which is not fairness, it is a room where
        nothing moves. (Measured: it deadlocked the contention simulation
        outright — see tests/test_invariants.py.) The one way a holder could
        still dodge its deadline by letting go and re-taking the region is
        closed by ``_carry``, which costs nobody anything.

        A reservation says `wait` to everyone else, including agents that
        outrank the reserved one, and that is on purpose: it is the only edge in
        the whole system that is not ordered by tier. It is safe because it is
        the only one with a hard expiry that nothing can renew — `RESERVATION_S`
        from a lease that has already ended — so it cannot participate in an
        unbounded wait. Every wait in this system is now bounded: by the
        holder's TTL, by the handover grace, or by this.
        """
        winner = claim.handover_winner()
        if winner is None:
            return None
        if claim.handover_at is None or claim.handover_at > now:
            # Ended early. Nothing is reserved, but the ask is remembered, so
            # letting go one second before the deadline and taking the region
            # straight back does not buy the holder a fresh fifteen minutes.
            #
            # The winner and the deadline, not the whole queue: everyone else is
            # polling and re-registers against the next claim on its own, so
            # keeping them here buys nothing and costs one live dict per
            # (region, agent) that ever let go of a contended lease — 200k
            # objects for the collector to walk, at 200 agents on 5 regions.
            self._carry[(claim.room, claim.scope, claim.agent)] = (
                winner, claim.handover_at,
            )
            if len(self._carry) > _CARRY_MAX:
                # Swept on growth, not on every write, for the same reason.
                # Everything here expires on its own deadline; the sweep only
                # decides when the memory goes back.
                self._carry = {
                    k: v for k, v in self._carry.items()
                    if v[1] is not None and v[1] > now
                }
            return None
        reservation = Reservation(
            room=claim.room,
            scope=claim.scope,
            agent=winner.agent,
            human=winner.human,
            priority=winner.priority,
            expires_at=now + RESERVATION_S,
            from_agent=claim.agent,
            from_human=claim.human,
        )
        self._reservations.append(reservation)
        return reservation

    def _resume_carry(self, claim: Claim, now: float) -> None:
        """Re-attach the asks a previous claim on this exact region by this
        exact agent was carrying, if its deadline has not passed us by.

        Without this the fair-share bound has one seam: a holder that releases
        at minute fourteen and re-claims immediately starts a brand new claim
        with no contenders and a brand new fifteen minutes, and can keep doing
        that forever. Nothing legitimate churns a lease that way — presenced
        renews, it does not let go and re-take — so in practice this restores
        nothing and costs one dict lookup per grant. It is here because "nothing
        legitimate does that" is not the same as "nothing can".

        Keyed on the agent as well as the region: this is about one agent
        dodging its own deadline. A *different* agent taking the region is the
        handover working, and it starts clean.
        """
        if not self._carry:
            return
        key = (claim.room, claim.scope, claim.agent)
        carried = self._carry.pop(key, None)
        if carried is None:
            return
        winner, deadline = carried
        if deadline is None or deadline <= now:
            return
        claim.note_contender(winner)
        claim.handover_at = deadline
        claim.expires_at = min(claim.expires_at, deadline)

    def _live_reservations(self) -> list[Reservation]:
        # Empty in every room that is not mid-handover, which is the steady
        # state, so the common path allocates nothing.
        if not self._reservations:
            return self._reservations
        now = self._clock.now()
        self._reservations = [r for r in self._reservations if r.expires_at > now]
        return self._reservations

    def reservation_for(self, room: str, region: Region) -> Reservation | None:
        for r in self._live_reservations():
            if r.room == room and same_region(r.scope, region):
                return r
        return None

    def _consume_reservation(self, room: str, region: Region, agent: str) -> (
        Reservation | None
    ):
        """Drop every reservation this agent's claim satisfies, and hand back
        the one that named it. Claiming the region is the point of the
        reservation, so holding on to it afterwards would only block the agent's
        own later claims on neighbouring symbols."""
        if not self._reservations:
            return None
        taken: Reservation | None = None
        kept: list[Reservation] = []
        for r in self._live_reservations():
            if r.room == room and same_region(r.scope, region) and r.agent == agent:
                taken = r if taken is None else taken
                continue
            kept.append(r)
        self._reservations = kept
        return taken

    def _contend(
        self, held: Claim, agent: str, human: str, tier: int,
        decision: Decision, now: float,
    ) -> None:
        """Record that `agent` wants this region, and cap the holder's renewal.

        The cap is anchored to the *first* time anybody asked and only ever
        moves earlier. A holder cannot push its own deadline out by outlasting
        one contender, and a stream of junior contenders cannot push out the
        deadline a senior one set.
        """
        existing = held.contenders.get(agent)
        held.note_contender(Contender(
            agent=agent,
            human=human,
            priority=tier,
            first_asked_at=now if existing is None else existing.first_asked_at,
        ))

        grace = HANDOVER_GRACE_S if decision == "wait" else FAIR_SHARE_GRACE_S
        deadline = now + grace
        if held.handover_at is None or deadline < held.handover_at:
            held.handover_at = deadline
        held.expires_at = min(held.expires_at, held.handover_at)

    def contend(
        self, room: str, scope: Region, agent: str, human: str, tier: int,
        requester_acquired_at: float | None = None,
    ) -> Claim | None:
        """Register an ask for a region somebody else holds, without taking it.

        The hook path never sends a claim frame — it asks the daemon whether an
        edit may proceed and the relay answers out of the lease table — so an
        agent can be blocked on the same region a hundred times and, before
        this, never once start the holder's clock. The bound has to attach to
        the *ask*, whichever channel it arrives on, or the two channels give
        the same contention two different endings.

        Returns the holder, or None if there is nothing to contend.
        """
        held = self.holder_of(room, scope)
        if held is None or held.agent == agent:
            return None
        age = (
            self.age_of(agent)
            if requester_acquired_at is None
            else requester_acquired_at
        )
        decision = resolve(agent, age, held, tier)
        self._contend(held, agent, human, tier, decision, self._clock.now())
        return held

    def _renew_to(self, claim: Claim, now: float) -> float:
        """A renewed expiry, never past the handover deadline."""
        want = now + LEASE_TTL_S
        if claim.handover_at is None:
            return want
        return min(want, claim.handover_at)

    def holder_of(self, room: str, region: Region) -> Claim | None:
        for c in self._live():
            if c.room == room and same_region(c.scope, region):
                return c
        return None

    def active_claims(self, room: str) -> list[Claim]:
        return [c for c in self._live() if c.room == room]

    def age_of(self, agent: str) -> float:
        """The agent's wait-die age: when its oldest live claim was acquired,
        or when it was first seen if it holds nothing right now.

        Age is deliberately not room-scoped: it stands in for the agent's
        whole session, and a wait-for cycle can run through leases in more
        than one room. "The whole session" is the operative phrase — an agent
        between claims (asked, was refused, released; about to ask again) is
        not a brand new agent, and its age must not reset just because it is
        not holding anything at the exact instant it asks. It used to: that
        made a requester with no live lease always younger than any existing
        holder, so the `wait` half of wait-die was unreachable for the
        ordinary shape of contention, where an agent contests one region at a
        time rather than holding an older one while it asks for another.

        The first time an agent with nothing held is seen, its age latches
        to that moment and is remembered in ``_first_seen`` — an agent that
        has genuinely never been seen before really is the youngest possible,
        so this changes nothing for a first-ever ask. ``release_everywhere``
        clears the entry: that is the identity-handoff path, and an agent id
        that changes hands must not hand the new holder the old one's
        seniority any more than it hands it the old one's priority tier.

        Every live claim an agent holds carries this same value — see the note
        in ``acquire`` — so ``age_of(x)`` and ``claim.acquired_at`` for any of
        x's claims are the same number, which is what lets ``resolve`` compare
        the two sides at all.
        """
        held = [c.acquired_at for c in self._live() if c.agent == agent]
        if held:
            return min(held)
        seen = self._first_seen.get(agent)
        if seen is not None:
            return seen
        now = self._clock.now()
        self._first_seen[agent] = now
        return now

    def priority_of(self, agent: str, default: int = PRIORITY_NORMAL) -> int:
        """The tier stamped on this agent's live claims, or ``default``.

        The exact trick ``age_of`` plays, for the exact same reason. ``resolve``
        reads the requester's tier from here and the holder's from
        ``claim.priority``, and those are only comparable while every live claim
        an agent holds carries one tier. ``acquire`` stamps every claim with
        this value, so they do.

        Not room-scoped, again like ``age_of``: a wait-for cycle can run through
        leases in more than one room, and an agent that reads as ``critical`` in
        one room and ``normal`` in another is exactly the asymmetry that would
        let one open.

        ``max`` rather than ``min`` because more entitled is the direction that
        matters, but by the invariant above every element is equal anyway.
        """
        held = [c.priority for c in self._live() if c.agent == agent]
        return max(held) if held else default

    def key_of(self, agent: str, default: int = PRIORITY_NORMAL) -> OrderKey:
        """This agent's position in the one total order. Smaller is more
        entitled. What ``resolve`` compares, assembled in one place so a test
        can assert a claim's stamp against it."""
        return order_key(self.priority_of(agent, default), self.age_of(agent), agent)

    def acquire(
        self,
        room: str,
        human: str,
        agent: str,
        scope: Region,
        intent: str,
        requester_acquired_at: float | None = None,
        priority: int = PRIORITY_NORMAL,
    ) -> AcquireResult:
        # `priority` is only ever a *default*: an agent that already holds
        # something keeps the tier those claims carry. Nothing here can be
        # reached from a claim frame — the relay resolves the tier from the
        # roster and passes it in, and the roster is not something a client can
        # write to. See relay.Relay.priority_of.
        #
        # That latch is only safe because an agent id means one thing at a time.
        # It used to not: this line reads the tier off *any* live claim carrying
        # the id, and an unauthenticated client that declared a rostered
        # principal's agent id — broadcast on every presence frame and in the
        # join snapshot — inherited that principal's tier here, in another room,
        # and kept inheriting it from its own laundered claims after the real
        # principal went home. `Relay.join` now binds an id to one grant for as
        # long as any connection holds it, so "the tier on this agent's claims"
        # and "the tier this agent was granted" cannot disagree. Do not relax
        # one of those two without the other.
        tier = self.priority_of(agent, default=priority)
        now = self._clock.now()

        held = self.holder_of(room, scope)
        if held is not None and held.agent != agent:
            age = (
                self.age_of(agent)
                if requester_acquired_at is None
                else requester_acquired_at
            )
            decision = resolve(agent, age, held, tier)
            # Contention is what bounds a lease. Until this call the holder
            # could renew forever: every claim frame from it reset expires_at to
            # now + 90 s, so "the senior waits out at most one TTL and then
            # wins" was true only of a holder that had stopped working, which is
            # the one case where nobody needed it to be true. An active holder
            # blocked a critical requester indefinitely — measured at 5760
            # refusals over eight hours with not one grant.
            #
            # Recording the ask caps the holder's renewal, so the wait has an
            # end the requester can be told about. It is not preemption: the
            # holder keeps the region for the whole grace, is told the deadline
            # while there is still time to finish, and nothing is taken from it
            # mid-edit.
            self._contend(held, agent, human, tier, decision, now)
            return AcquireResult(
                ok=False,
                held_by=held,
                decision=decision,
                handover_at=held.handover_at,
            )

        if held is not None:
            # Renewal by the holder. Checked before reservations on purpose: an
            # agent that already holds a region must never be refused its own
            # renewal, or a reservation on a neighbouring symbol could expire a
            # lease out from under an agent that is mid-edit.
            held.expires_at = self._renew_to(held, now)
            return AcquireResult(ok=True, claim=held)

        reserved = self.reservation_for(room, scope)
        if reserved is not None and reserved.agent != agent:
            # Somebody else's handover freed this region for them seconds ago.
            # Always `wait`, never `abort`: aborting would drop this agent's
            # other leases over a condition that clears on its own inside
            # RESERVATION_S, which is a lot of destruction for a short queue.
            return AcquireResult(
                ok=False, decision="wait", reserved_by=reserved,
            )

        inherited = self._consume_reservation(room, scope, agent)

        # acquired_at is the agent's wait-die timestamp, not this lease's wall
        # clock. A second lease inherits the age of the first, so all of an
        # agent's claims are stamped alike.
        #
        # This matters because resolve() orders the requester by age_of (oldest
        # live claim) and the holder by the acquired_at of the one contested
        # claim. Stamp each lease with its own wall clock and those are two
        # different quantities: an agent holding an old lease and a young one
        # reads as old when it asks and young when it is asked, so two agents
        # can each be told to wait for the other and neither ever dies. Sharing
        # one timestamp per agent makes the relation a total order over agents
        # (ties broken on agent id), and a total order has no cycles.
        #
        # Expiry still runs on the real clock; only the ordering key is shared.
        #
        # `priority` is latched the same way and for the same reason. An agent
        # whose tier changed mid-session must not end up holding two claims at
        # two tiers, or it reads as senior when it asks and junior when it is
        # asked — the same two-quantity bug as above, one component to the left.
        claim = Claim(
            room=room,
            human=human,
            agent=agent,
            scope=scope,
            intent=intent,
            state="held",
            acquired_at=self.age_of(agent),
            expires_at=now + LEASE_TTL_S,
            priority=tier,
        )
        self._resume_carry(claim, now)
        self._claims.append(claim)
        return AcquireResult(ok=True, claim=claim, inherited=inherited)

    def heartbeat(self, room: str, agent: str, scope: Region) -> bool:
        now = self._clock.now()
        for c in self._live():
            if c.room == room and c.agent == agent and same_region(c.scope, scope):
                # Capped like every other renewal. The daemon heartbeats every
                # 30 s whether or not anybody is waiting, so leaving this one
                # uncapped would reopen the whole hole from the other side.
                c.expires_at = self._renew_to(c, now)
                return True
        return False

    def release(self, room: str, agent: str, scope: Region) -> None:
        now = self._clock.now()
        keep, gone = [], []
        for c in self._live():
            target = (
                c.room == room and c.agent == agent and same_region(c.scope, scope)
            )
            (gone if target else keep).append(c)
        self._claims = keep
        # A released region owes its contenders the same reservation an expired
        # one does, or the polite holder — the one that did HANDOFF, or finished
        # early and let go — hands the region straight back to itself on its
        # next claim and the agent that waited gets nothing for waiting.
        for c in gone:
            self._hand_over(c, now)
        # `release` is always voluntary in production — the wire "release"
        # frame and HANDOFF are the only two callers, and both mean "this
        # agent is done here", not "this agent was forced off". If letting go
        # leaves it holding nothing anywhere, whatever it was doing is
        # finished, and the next thing it asks for is new work, not a retry —
        # so its age starts fresh next time `age_of` is asked. Contrast
        # `release_all`, whose own docstring says its two uses are session end
        # and a wait-die abort: neither is a transaction concluding on its own
        # terms, so neither touches `_first_seen`. Losing this distinction
        # either way breaks something: keep resetting on every empty-handed
        # moment and an abort-retry never gets old enough to be told `wait`
        # (see `age_of`); stop resetting here too and the first agent to ever
        # connect outranks the whole room forever, deadlock-free schedule or
        # not (see the ring simulation in test_invariants.py).
        if gone and not any(c.agent == agent for c in self._claims):
            self._first_seen.pop(agent, None)

    def release_everywhere(self, agent: str) -> None:
        """Drop every lease this agent id holds, in every room.

        The one caller is ``Relay._bind_agent``, and the narrowness is the whole
        justification. ``release_all`` is room-scoped because an agent id is not
        unique to a room — two checkouts on one laptop share
        ``presenced@<hostname>`` — and one room's refusal has no business
        dropping another room's leases.

        This is the opposite case. The id itself has changed hands: no live
        connection holds it and the one that does now was granted a different
        tier, so every claim still standing under that id belongs to a session
        that is gone. Leaving them is what let the tier outlive the session —
        ``acquire`` reads an agent's tier off that agent's live claims, so a
        stranded ``critical`` claim hands ``critical`` to whoever takes the name
        next.

        Same reasoning, one component to the left: forgetting ``_first_seen``
        here is what stops the id handing its old *age* to whoever takes the
        name next, the same way dropping the claims stops it handing over the
        tier.
        """
        now = self._clock.now()
        keep, gone = [], []
        for c in self._live():
            (gone if c.agent == agent else keep).append(c)
        self._claims = keep
        for c in gone:
            self._hand_over(c, now)
        self._first_seen.pop(agent, None)

    def release_all(self, room: str, agent: str) -> None:
        """Drop every lease an agent holds *in one room*. Used on session end
        and on a wait-die abort.

        Room-scoped, like every other per-lease operation here. It used to sweep
        every room, and an agent id is not unique to a room: presenced names
        itself ``presenced@<hostname>``, so two checkouts on one laptop are two
        rooms sharing one id. A refused claim or a closed socket in one of them
        dropped the other's leases, and the agent still editing in that other
        room lost its protection without being told.

        Deadlock freedom does not depend on the sweep being global. Wait-die
        orders agents by ``age_of``, which is global, and an agent only ever
        waits on an older one — the wait-for graph is acyclic by construction,
        whatever a release touches. The sweep is here so a dying claimer is not
        still holding things while it retries, and the room it was refused in is
        the only room that has anything to do with that.
        """
        now = self._clock.now()
        keep, gone = [], []
        for c in self._live():
            (gone if (c.room == room and c.agent == agent) else keep).append(c)
        self._claims = keep
        for c in gone:
            self._hand_over(c, now)
