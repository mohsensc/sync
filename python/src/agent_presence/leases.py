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

        claim = Claim(
            room=room,
            human=human,
            agent=agent,
            scope=scope,
            intent=intent,
            state="held",
            acquired_at=now,
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

    def release_all(self, agent: str) -> None:
        """Drop every lease an agent holds, in every room. Used on session end
        and on a wait-die abort, where partial release would leave a cycle."""
        self._claims = [c for c in self._live() if c.agent != agent]
