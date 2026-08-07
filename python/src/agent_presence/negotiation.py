from __future__ import annotations

import logging
from dataclasses import dataclass
from typing import Literal

from .clock import Clock
from .leases import LeaseRegistry
from .types import Region, same_region
from .wait_die import Decision, resolve

log = logging.getLogger("agent_presence.negotiation")

Move = Literal["DEFER", "SPLIT", "HANDOFF", "PROCEED"]
MOVES: tuple[Move, ...] = ("DEFER", "SPLIT", "HANDOFF", "PROCEED")


def normalize_move(move: object) -> str | None:
    """Fold a client-supplied move to its canonical spelling, or None.

    Agents write ``split``, ``Split``, `` SPLIT `` and mean the same thing.
    Rejecting those is a protocol tax with no upside.
    """
    if not isinstance(move, str):
        return None
    candidate = move.strip().upper()
    return candidate if candidate in MOVES else None


@dataclass
class Brief:
    """What a blocked agent is told. Deliberately small: who, what they intend,
    what is contested, what wait-die says to do, and the finite set of replies."""

    holder_agent: str
    holder_human: str
    holder_intent: str
    region: Region
    moves: tuple[Move, ...]
    decision: Decision = "abort"


@dataclass
class NegotiationOutcome:
    granted: bool
    action: str
    logged_override: bool = False
    # Populated instead of raising, so a bad move never escapes as an
    # exception through the MCP tool boundary.
    error: str | None = None


class Negotiator:
    def __init__(self, registry: LeaseRegistry, clock: Clock) -> None:
        self._registry = registry
        self._clock = clock

    def open(
        self, room: str, requester: str, requester_acquired_at: float,
        scope: Region, intent: str,
    ) -> Brief | None:
        """Return a brief if the region is contested, else None.

        ``requester_acquired_at`` is the requester's wait-die age. It decides
        whether the brief tells the agent to hold its place and wait or to
        drop everything and retry, so it is never ignored.
        """
        held = self._registry.holder_of(room, scope)
        if held is None or held.agent == requester:
            return None
        return Brief(
            holder_agent=held.agent,
            holder_human=held.human,
            holder_intent=held.intent,
            region=scope,
            moves=MOVES,
            decision=resolve(requester, requester_acquired_at, held),
        )

    def apply(
        self, room: str, requester: str, scope: Region, move: str,
        reason: str = "", split_scope: Region | None = None,
    ) -> NegotiationOutcome:
        """Apply a negotiation move.

        ``scope`` is the contested region. ``split_scope`` is only read for
        SPLIT and names the sub-region the requester wants instead; leaving it
        None means "split off ``scope`` itself", which is only legal when
        nobody else holds it.
        """
        canonical = normalize_move(move)
        if canonical is None:
            return NegotiationOutcome(
                granted=False,
                action="invalid_move",
                error=(
                    f"unknown negotiation move: {move!r}; "
                    f"expected one of {', '.join(MOVES)}"
                ),
            )

        if canonical == "DEFER":
            return NegotiationOutcome(granted=False, action="defer")

        if canonical == "SPLIT":
            return self._split(room, requester, scope, split_scope)

        if canonical == "HANDOFF":
            self._registry.release(room, requester, scope)
            return NegotiationOutcome(granted=False, action="handoff")

        # PROCEED — the escape hatch. Always available, always logged. False
        # positives are certain, and a system that cannot be overridden is a
        # system that gets uninstalled. Override logs are the tuning signal.
        log.warning(
            "override: agent=%s room=%s path=%s symbol=%s reason=%s",
            requester, room, scope.path, scope.symbol, reason or "(none)",
        )
        return NegotiationOutcome(granted=True, action="proceed", logged_override=True)

    def _split(
        self, room: str, requester: str, scope: Region,
        split_scope: Region | None,
    ) -> NegotiationOutcome:
        """Carve off a sub-region that does not touch what the holder has.

        A split that lands back on the holder's own region is not a split, it
        is a DEFER wearing a different hat, and the agent deserves to be told
        which of the two happened.
        """
        target = scope if split_scope is None else split_scope
        held = self._registry.holder_of(room, scope)

        if held is not None and held.agent != requester:
            if same_region(target, held.scope):
                return NegotiationOutcome(
                    granted=False,
                    action="split_rejected",
                    error=(
                        f"split scope {_name(target)} overlaps "
                        f"{held.agent}'s region {_name(held.scope)}; "
                        "name a disjoint sub-region"
                    ),
                )
            if target.path != held.scope.path:
                # Not a split of the contested file at all. Allowed, but say so
                # plainly rather than pretending the contention was resolved.
                log.info(
                    "split outside the contested file: agent=%s room=%s target=%s",
                    requester, room, _name(target),
                )

        result = self._registry.acquire(room, requester, requester, target, "split")
        if not result.ok:
            return NegotiationOutcome(
                granted=False,
                action="split_rejected",
                error=(
                    f"split scope {_name(target)} is already held by "
                    f"{result.held_by.agent}"
                ),
            )
        return NegotiationOutcome(granted=True, action="split")


def _name(region: Region) -> str:
    return f"{region.path}:{region.symbol or '*'}"
