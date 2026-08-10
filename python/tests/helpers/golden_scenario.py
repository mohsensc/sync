"""The scenario `test_golden_noop.py` locks down.

Kept as a module of its own so it can be run against an older checkout — the
whole point of the golden test is that installing the policy engine and
configuring nothing changes nothing, and that is only checkable by running the
same script on both sides.

    python tests/helpers/golden_scenario.py    # prints the frames as JSON
"""

from __future__ import annotations

import json

from agent_presence.clock import VirtualClock
from agent_presence.relay import Relay

ROOM = "golden"


class Recorder:
    """A connection that keeps everything the relay pushes at it."""

    def __init__(self, agent: str, human: str) -> None:
        self.agent, self.human, self.room = agent, human, None
        self.sent: list[dict] = []

    def send(self, payload: dict) -> None:
        self.sent.append(payload)


def _region(path: str, symbol: str | None = "sym") -> dict:
    return {"path": path, "symbol": symbol, "lines": None}


def run() -> dict:
    """Every relay-visible output for a two-agent contention, in order."""
    clock = VirtualClock(1000.0)
    relay = Relay(clock)
    a = Recorder("a1", "sara")
    b = Recorder("a2", "dev")

    replies: list[dict] = []

    relay.join(ROOM, a)
    clock.advance(1.0)
    relay.join(ROOM, b)

    # a1 takes a lease, then a2 contends for it and loses.
    replies.append(relay.handle(
        a, {"type": "claim", "region": _region("src/auth.py"), "intent": "refactor"}
    ))
    clock.advance(1.0)
    replies.append(relay.handle(
        b, {"type": "claim", "region": _region("src/auth.py"), "intent": "rename"}
    ))

    # Rung 0: a2 reads a file nobody is writing.
    replies.append(relay.handle(
        b, {"type": "event", "verb": "read", "region": _region("src/db.py", "query")}
    ))
    # Rung 2: both edit the same file, different symbols.
    replies.append(relay.handle(
        a, {"type": "event", "verb": "edit", "region": _region("src/db.py", "insert")}
    ))
    replies.append(relay.handle(
        b, {"type": "event", "verb": "edit", "region": _region("src/db.py", "query")}
    ))
    # Rung 3: same symbol, and a1 already holds the lease on it.
    replies.append(relay.handle(
        a, {"type": "claim", "region": _region("src/pay.py", "charge"),
            "intent": "fix rounding"}
    ))
    replies.append(relay.handle(
        a, {"type": "event", "verb": "edit", "region": _region("src/pay.py", "charge")}
    ))
    replies.append(relay.handle(
        b, {"type": "event", "verb": "edit", "region": _region("src/pay.py", "charge")}
    ))

    # a1 lets go; the room hears about it.
    replies.append(relay.handle(
        a, {"type": "release", "region": _region("src/auth.py")}
    ))

    return {
        "replies": [r for r in replies if r is not None],
        "a1_received": a.sent,
        "a2_received": b.sent,
    }


if __name__ == "__main__":
    print(json.dumps(run(), indent=2, sort_keys=True))
