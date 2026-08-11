"""Wait-die has to reach the caller, not just exist in wait_die.py.

This covers the wire path: a `claim` message on the relay. A refusal that
carries no instruction is how two agents end up retrying at each other
forever, so the older claimant must be told to wait and keep what it holds,
and the younger one must be told to abort and actually lose what it holds.

The tool path (`claim_work` over MCP) used to be covered here too, against
the Python `Tools`/`RelayConnection` pair. That surface is Go now (#32) —
`go/internal/mcptools`'s own tests cover the same claim, over a real
websocket, against the same relay wire protocol this file exercises.
"""

from __future__ import annotations

from agent_presence.clock import VirtualClock
from agent_presence.relay import Relay
from agent_presence.types import Region

OTHER = {"path": "src/db.py", "symbol": "query", "lines": None}
CONTESTED = {"path": "src/auth.py", "symbol": "sign_in", "lines": None}


def region(d: dict) -> Region:
    return Region(path=d["path"], symbol=d["symbol"], lines=None)


class FakeConn:
    def __init__(self, agent: str, human: str) -> None:
        self.agent, self.human, self.room = agent, human, None
        self.sent: list[dict] = []

    def send(self, payload: dict) -> None:
        self.sent.append(payload)


def holds(relay: Relay, agent: str) -> list[str]:
    return sorted(c.scope.path for c in relay.registry.active_claims("r1") if c.agent == agent)


def claim(relay: Relay, conn: FakeConn, region_d: dict) -> dict:
    return relay.handle(conn, {"type": "claim", "region": region_d, "intent": "work"})


def test_the_wire_path_tells_the_older_claimant_to_wait():
    relay = Relay(VirtualClock(1000.0))
    a, b = FakeConn("a1", "sara"), FakeConn("a2", "dev")
    relay.join("r1", a)
    relay.join("r1", b)

    claim(relay, b, OTHER)            # a2 starts first, so a2 is the older one
    relay._clock.advance(5)
    claim(relay, a, CONTESTED)

    reply = claim(relay, b, CONTESTED)
    assert reply["granted"] is False
    assert reply["decision"] == "wait"
    # Waiting costs the waiter nothing it already had.
    assert holds(relay, "a2") == ["src/db.py"]


def test_the_wire_path_tells_the_younger_claimant_to_abort():
    relay = Relay(VirtualClock(1000.0))
    a, b = FakeConn("a1", "sara"), FakeConn("a2", "dev")
    relay.join("r1", a)
    relay.join("r1", b)

    claim(relay, a, CONTESTED)        # a1 is the older one
    relay._clock.advance(5)
    claim(relay, b, OTHER)

    reply = claim(relay, b, CONTESTED)
    assert reply["granted"] is False
    assert reply["decision"] == "abort"
    # Aborting has to actually drop the loser's leases, or the cycle survives.
    assert holds(relay, "a2") == []
    assert holds(relay, "a1") == ["src/auth.py"]
