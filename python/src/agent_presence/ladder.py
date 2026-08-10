from __future__ import annotations

import logging
import os
from dataclasses import dataclass

from .similarity import IntentSimilarity, default_similarity
from .types import AgentEvent, Region, Source, Verb, same_region

log = logging.getLogger("agent_presence.ladder")

WRITES: frozenset[str] = frozenset({"edit"})

# Rung 4 is off unless somebody turns it on, and stays that way until there is
# real traffic to tune against. The design is explicit about why: a noisy rung 4
# poisons trust in rungs 0-3, which are the rungs that work. Same truthy
# spelling as AGENT_PRESENCE_OPAQUE, read per call so flipping it needs no
# restart.
RUNG4_ENV = "AGENT_PRESENCE_RUNG4"
THRESHOLD_ENV = "AGENT_PRESENCE_RUNG4_THRESHOLD"
_TRUTHY = frozenset({"1", "true", "yes", "on"})

# Tuned in python/tools/tune_rung4.py. Sits above the worst near miss with room
# to spare rather than in the middle of the gap, because the two error types do
# not cost the same: a missed duplicate leaves an agent exactly where it would
# have been with this feature switched off, while a false interrupt teaches a
# person that the whole ladder cries wolf.
DEFAULT_RUNG4_THRESHOLD = 0.82


@dataclass
class Activity:
    agent: str
    human: str
    verb: Verb
    region: Region
    # MCP-declared intent; empty when the activity was only observed via hooks.
    intent: str
    # Which channel this came from. Defaults to "hook" so anything constructed
    # without saying otherwise is inert for rung 4 - the safe direction.
    source: Source = "hook"


@dataclass(frozen=True)
class Redundancy:
    """Who else is already doing this work, and how sure we are.

    Everything the second agent needs to decide for itself: who they are, what
    they said they were doing, where, and the score, so the number is auditable
    rather than an oracle.
    """

    agent: str
    human: str
    intent: str
    region: Region
    score: float


def rung4_enabled() -> bool:
    return os.environ.get(RUNG4_ENV, "").strip().lower() in _TRUTHY


def rung4_threshold() -> float:
    """The similarity a pair of intents has to clear. Out-of-range or
    unparseable values fall back to the default instead of raising: a fat
    finger in an env var must not decide that everything is redundant."""
    raw = os.environ.get(THRESHOLD_ENV, "").strip()
    if not raw:
        return DEFAULT_RUNG4_THRESHOLD
    try:
        value = float(raw)
    except ValueError:
        log.warning("ignoring unparseable %s=%r", THRESHOLD_ENV, raw)
        return DEFAULT_RUNG4_THRESHOLD
    if not 0.0 < value <= 1.0:
        log.warning("ignoring out-of-range %s=%r", THRESHOLD_ENV, raw)
        return DEFAULT_RUNG4_THRESHOLD
    return value


def redundant_peer(
    incoming: AgentEvent,
    others: list[Activity],
    intent: str,
    similarity: IntentSimilarity | None = None,
) -> Redundancy | None:
    """The strongest rung 4 match against the incoming agent's declared intent.

    Rung 4 is the collision the hooks structurally cannot see: two agents doing
    the same work in *different* files, so there is no region overlap to find
    and the only evidence is what each one declared it was doing.

    Four things have to hold, and all four are refusals rather than judgement
    calls:

    1. The flag is on. Off is the default and off means this returns None
       before any text is looked at.
    2. Both sides declared an intent through MCP. Hook events carry no intent
       by construction - `source` and `intent` are both checked, because the
       empty string is the ordinary case and a bug that fills it in should not
       silently promote hook traffic into rung 4.
    3. The paths differ. Same-path contention is already rungs 0-3 and those
       decide on facts; routing it through a text comparison would replace a
       certain signal with a guess.
    4. The score clears the threshold.

    Returns the best match, not the first, so the interrupt names the agent
    most likely to actually be duplicating the work.
    """
    if not rung4_enabled():
        return None
    if incoming.source != "mcp" or not intent.strip():
        return None

    scorer = similarity if similarity is not None else default_similarity()
    threshold = rung4_threshold()

    best: Redundancy | None = None
    for o in others:
        if o.agent == incoming.agent:
            continue
        if o.source != "mcp" or not o.intent.strip():
            continue
        if o.region.path == incoming.region.path:
            continue

        score = scorer.score(intent, o.intent)
        if score < threshold:
            continue
        if best is None or score > best.score:
            best = Redundancy(agent=o.agent, human=o.human, intent=o.intent,
                              region=o.region, score=score)
    return best


def classify(
    incoming: AgentEvent,
    others: list[Activity],
    intent: str = "",
    similarity: IntentSimilarity | None = None,
) -> int:
    """Return the highest rung the incoming event reaches against everyone else.

    Rungs 0-3 are decided on region overlap and are always live. Rung 4 is
    decided on declared intent across *different* paths and is off unless
    AGENT_PRESENCE_RUNG4 says otherwise, so with the flag down this function
    behaves exactly as it did before rung 4 existed.

    `intent` is the incoming agent's own declaration. It is a parameter rather
    than a field on AgentEvent because an event is an observation and intent is
    a claim; only the MCP channel has one to pass.
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

    if redundant_peer(incoming, others, intent, similarity) is not None:
        highest = max(highest, 4)

    return highest


def interrupts_at(rung: int) -> bool:
    """Rungs 0-2 are ambient by design. Attention is the scarce resource, so
    each rung upward must earn the cost of spending it."""
    return rung >= 3
