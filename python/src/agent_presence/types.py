from __future__ import annotations

from dataclasses import dataclass, field
from typing import Literal

from .priority import PRIORITY_NORMAL

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


@dataclass(frozen=True)
class Contender:
    """Somebody who asked for a region while this claim held it.

    Kept per agent rather than as a count, because when the lease ends the
    region goes to the most entitled of them and that needs the tier and the
    time they first asked, not a tally.
    """

    agent: AgentId
    human: HumanId
    priority: int
    first_asked_at: float


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
    # Relay-assigned too, and from the roster, never from the claim frame. It
    # is the *agent's* tier latched at its first live claim, not this lease's,
    # for the same reason acquired_at is — see LeaseRegistry.acquire. Defaults
    # to normal so a Claim built anywhere else orders exactly as it used to.
    priority: int = PRIORITY_NORMAL
    # When this lease stops being renewable, and who has been asking. None
    # means nobody has contended it yet, which is the uncontended case and the
    # common one: an agent working alone renews forever, exactly as before.
    # See LeaseRegistry.acquire for why contention has to cap the renewal.
    handover_at: float | None = None
    contenders: dict[AgentId, Contender] = field(default_factory=dict)

    def handover_winner(self) -> Contender | None:
        """The contender this region goes to when the lease ends. Most entitled
        first, then whoever asked earliest, then agent id — the same three
        components, in the same order, as ``wait_die.order_key``."""
        if not self.contenders:
            return None
        return min(
            self.contenders.values(),
            key=lambda c: (-c.priority, c.first_asked_at, c.agent),
        )


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
