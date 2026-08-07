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
    # Relay-assigned. Wait-die ordering derives from this.
    acquired_at: float
    expires_at: float


def same_region(a: Region, b: Region) -> bool:
    """True when two regions contend for the same code.

    The rules, in order:

    1. Different paths never contend.
    2. ``symbol=None`` means *the whole file*, so it contends with every
       symbol in that path, including another whole-file region. A claim on
       the file has to block a claim on a function inside it, otherwise
       "I am rewriting this file" would silently coexist with "I am editing
       this method".
    3. Two symbol-level regions contend only when the symbols are equal.

    Line ranges never narrow this. The symbol is the unit of contention.

    Note this is a conflict predicate, not an equivalence relation: whole-file
    contends with ``sign_in`` and with ``sign_out``, which do not contend with
    each other. That asymmetry is intended; do not "fix" it into equality.
    """
    if a.path != b.path:
        return False
    if a.symbol is None or b.symbol is None:
        return True
    return a.symbol == b.symbol
