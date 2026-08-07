from __future__ import annotations

from dataclasses import dataclass
from typing import Literal

Verb = Literal["read", "edit", "search", "run", "think"]
Source = Literal["hook", "mcp"]
LeaseState = Literal["soft", "held"]

RoomId = str
AgentId = str
HumanId = str


@dataclass(frozen=True)
class Region:
    """A contended unit of code. Frozen so it can key a cache."""

    path: str
    symbol: str | None
    lines: tuple[int, int] | None


@dataclass
class AgentEvent:
    room: RoomId
    human: HumanId
    agent: AgentId
    kind: Literal["touch", "claim", "release"]
    source: Source
    verb: Verb
    region: Region
    # Assigned by the relay on receipt. None until then.
    ts: float | None = None


@dataclass
class Claim:
    room: RoomId
    human: HumanId
    agent: AgentId
    scope: Region
    intent: str
    state: LeaseState
    # Relay-assigned. Wound-wait ordering derives from this.
    acquired_at: float
    expires_at: float


def same_region(a: Region, b: Region) -> bool:
    """Path and symbol determine identity. Line ranges do not narrow it —
    the symbol is the unit of contention."""
    return a.path == b.path and a.symbol == b.symbol
