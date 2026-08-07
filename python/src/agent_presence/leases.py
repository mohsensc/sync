from __future__ import annotations

from dataclasses import dataclass

from .clock import Clock
from .types import Claim, Region, same_region

LEASE_TTL_S = 90.0
PRESENCE_TTL_S = 30.0
HEARTBEAT_S = 30.0


@dataclass
class AcquireResult:
    ok: bool
    claim: Claim | None = None
    held_by: Claim | None = None


class LeaseRegistry:
    """In-memory lease registry. The relay owns exactly one.

    Expiry is lazy — nothing is swept on a timer — so there is no code path in
    which a crashed process leaves behind a lease that outlives its TTL.
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

    def acquire(
        self, room: str, human: str, agent: str, scope: Region, intent: str
    ) -> AcquireResult:
        held = self.holder_of(room, scope)
        if held is not None and held.agent != agent:
            return AcquireResult(ok=False, held_by=held)

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

    def heartbeat(self, agent: str, scope: Region) -> bool:
        for c in self._live():
            if c.agent == agent and same_region(c.scope, scope):
                c.expires_at = self._clock.now() + LEASE_TTL_S
                return True
        return False

    def release(self, agent: str, scope: Region) -> None:
        self._claims = [
            c for c in self._live()
            if not (c.agent == agent and same_region(c.scope, scope))
        ]

    def release_all(self, agent: str) -> None:
        """Drop every lease an agent holds. Used on session end and on abort."""
        self._claims = [c for c in self._live() if c.agent != agent]
