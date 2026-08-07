from __future__ import annotations

import logging
from dataclasses import dataclass
from typing import Literal

from .clock import Clock
from .leases import LeaseRegistry
from .types import Region

log = logging.getLogger("agent_presence.negotiation")

Move = Literal["DEFER", "SPLIT", "HANDOFF", "PROCEED"]
MOVES: tuple[Move, ...] = ("DEFER", "SPLIT", "HANDOFF", "PROCEED")


@dataclass
class Brief:
    """What a blocked agent is told. Deliberately small: who, what they intend,
    what is contested, and the finite set of replies."""

    holder_agent: str
    holder_human: str
    holder_intent: str
    region: Region
    moves: tuple[Move, ...]


@dataclass
class NegotiationOutcome:
    granted: bool
    action: str
    logged_override: bool = False


class Negotiator:
    def __init__(self, registry: LeaseRegistry, clock: Clock) -> None:
        self._registry = registry
        self._clock = clock

    def open(
        self, room: str, requester: str, requester_acquired_at: float,
        scope: Region, intent: str,
    ) -> Brief | None:
        """Return a brief if the region is contested, else None."""
        held = self._registry.holder_of(room, scope)
        if held is None or held.agent == requester:
            return None
        return Brief(
            holder_agent=held.agent,
            holder_human=held.human,
            holder_intent=held.intent,
            region=scope,
            moves=MOVES,
        )

    def apply(
        self, room: str, requester: str, scope: Region, move: str, reason: str = ""
    ) -> NegotiationOutcome:
        if move not in MOVES:
            raise ValueError(f"unknown negotiation move: {move!r}")

        if move == "DEFER":
            return NegotiationOutcome(granted=False, action="defer")

        if move == "SPLIT":
            result = self._registry.acquire(room, requester, requester, scope, "split")
            return NegotiationOutcome(granted=result.ok, action="split")

        if move == "HANDOFF":
            self._registry.release(requester, scope)
            return NegotiationOutcome(granted=False, action="handoff")

        # PROCEED — the escape hatch. Always available, always logged. False
        # positives are certain, and a system that cannot be overridden is a
        # system that gets uninstalled. Override logs are the tuning signal.
        log.warning(
            "override: agent=%s room=%s path=%s symbol=%s reason=%s",
            requester, room, scope.path, scope.symbol, reason or "(none)",
        )
        return NegotiationOutcome(granted=True, action="proceed", logged_override=True)
