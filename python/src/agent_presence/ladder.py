from __future__ import annotations

from dataclasses import dataclass

from .types import AgentEvent, Region, Verb, same_region

WRITES: frozenset[str] = frozenset({"edit"})


@dataclass
class Activity:
    agent: str
    human: str
    verb: Verb
    region: Region
    # MCP-declared intent; empty when the activity was only observed via hooks.
    intent: str


def classify(incoming: AgentEvent, others: list[Activity]) -> int:
    """Return the highest rung the incoming event reaches against everyone else.

    Rung 4 (semantically redundant work on *different* files) is deliberately
    not decided here — it requires embedding similarity at the relay and stays
    behind a flag until there is real traffic to tune against. Shipping a noisy
    rung 4 would destroy trust in rungs 0-3.
    """
    highest = 0

    for o in others:
        if o.agent == incoming.agent:
            continue
        if o.region.path != incoming.region.path:
            continue

        incoming_writes = incoming.verb in WRITES
        other_writes = o.verb in WRITES

        if incoming_writes and other_writes:
            rung = 3 if same_region(o.region, incoming.region) else 2
        elif other_writes:
            rung = 1
        else:
            rung = 0

        highest = max(highest, rung)

    return highest


def interrupts_at(rung: int) -> bool:
    """Rungs 0-2 are ambient by design. Attention is the scarce resource, so
    each rung upward must earn the cost of spending it."""
    return rung >= 3
