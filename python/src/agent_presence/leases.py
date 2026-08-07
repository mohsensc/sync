from __future__ import annotations

from dataclasses import dataclass

from .clock import Clock
from .types import Claim, Region, same_region
from .wait_die import Decision, resolve

LEASE_TTL_S = 90.0
PRESENCE_TTL_S = 30.0
HEARTBEAT_S = 30.0


@dataclass
class AcquireResult:
    ok: bool
    claim: Claim | None = None
    held_by: Claim | None = None
    # Only set when ok is False: what wait-die says the requester should do.
    decision: Decision | None = None


class LeaseRegistry:
    """In-memory lease registry. The relay owns exactly one.

    Expiry is lazy — nothing is swept on a timer — so there is no code path in
    which a crashed process leaves behind a lease that outlives its TTL.

    Every per-lease operation is scoped by room. Two rooms may use identical
    paths and must never see each other's leases.
    """

    def __init__(self, clock: Clock) -> None:
        self._clock = clock
        self._claims: list[Claim] = []

    def _live(self) -> list[Claim]:
        now = self._clock.now()
        self._claims = [c for c in self._claims if c.expires_at > now]
        return self._claims

    def holder_of(self, room: str, region: Region) -> Claim | None:
        for c in self._live():
            if c.room == room and same_region(c.scope, region):
                return c
        return None

    def active_claims(self, room: str) -> list[Claim]:
        return [c for c in self._live() if c.room == room]

    def age_of(self, agent: str) -> float:
        """The agent's wait-die age: when its oldest live claim was acquired.

        An agent holding nothing is brand new, so its age is now, which makes
        it lose to every existing holder. Age is deliberately not room-scoped:
        it stands in for the agent's whole session, and a wait-for cycle can
        run through leases in more than one room.

        Every live claim an agent holds carries this same value — see the note
        in ``acquire`` — so ``age_of(x)`` and ``claim.acquired_at`` for any of
        x's claims are the same number, which is what lets ``resolve`` compare
        the two sides at all.
        """
        held = [c.acquired_at for c in self._live() if c.agent == agent]
        return min(held) if held else self._clock.now()

    def acquire(
        self,
        room: str,
        human: str,
        agent: str,
        scope: Region,
        intent: str,
        requester_acquired_at: float | None = None,
    ) -> AcquireResult:
        held = self.holder_of(room, scope)
        if held is not None and held.agent != agent:
            age = (
                self.age_of(agent)
                if requester_acquired_at is None
                else requester_acquired_at
            )
            return AcquireResult(
                ok=False, held_by=held, decision=resolve(agent, age, held)
            )

        now = self._clock.now()
        if held is not None:
            held.expires_at = now + LEASE_TTL_S
            return AcquireResult(ok=True, claim=held)

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
        claim = Claim(
            room=room,
            human=human,
            agent=agent,
            scope=scope,
            intent=intent,
            state="held",
            acquired_at=self.age_of(agent),
            expires_at=now + LEASE_TTL_S,
        )
        self._claims.append(claim)
        return AcquireResult(ok=True, claim=claim)

    def heartbeat(self, room: str, agent: str, scope: Region) -> bool:
        for c in self._live():
            if c.room == room and c.agent == agent and same_region(c.scope, scope):
                c.expires_at = self._clock.now() + LEASE_TTL_S
                return True
        return False

    def release(self, room: str, agent: str, scope: Region) -> None:
        self._claims = [
            c for c in self._live()
            if not (
                c.room == room and c.agent == agent and same_region(c.scope, scope)
            )
        ]

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
        self._claims = [
            c for c in self._live() if not (c.room == room and c.agent == agent)
        ]
