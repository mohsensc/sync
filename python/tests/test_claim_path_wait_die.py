"""Wait-die has to reach the caller, not just exist in wait_die.py.

Both production claim paths are covered here: the wire path (a `claim` message
on the relay) and the tool path (`claim_work` over MCP). A refusal that carries
no instruction is how two agents end up retrying at each other forever, so the
older claimant must be told to wait and keep what it holds, and the younger one
must be told to abort and actually lose what it holds.
"""

from __future__ import annotations

import pytest

from agent_presence.clock import VirtualClock
from agent_presence.mcp_server import Tools, dispatch
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


@pytest.fixture(autouse=True)
def _opaque_off(monkeypatch):
    monkeypatch.delenv("AGENT_PRESENCE_OPAQUE", raising=False)


@pytest.fixture
def relay():
    return Relay(VirtualClock(1000.0))


def holds(relay: Relay, agent: str) -> list[str]:
    return sorted(c.scope.path for c in relay.registry.active_claims("r1") if c.agent == agent)


def claim(relay: Relay, conn: FakeConn, region_d: dict) -> dict:
    return relay.handle(conn, {"type": "claim", "region": region_d, "intent": "work"})


# -- the wire path -----------------------------------------------------------


def test_the_wire_path_tells_the_older_claimant_to_wait(relay):
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


def test_the_wire_path_tells_the_younger_claimant_to_abort(relay):
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


# -- the tool path -----------------------------------------------------------


def _tools(relay: Relay, agent: str, human: str) -> Tools:
    conn = FakeConn(agent, human)
    relay.join("r1", conn)
    return Tools(relay, "r1", agent, human)


def test_the_tool_path_tells_the_older_claimant_to_wait(relay):
    relay.registry.acquire("r1", "dev", "a2", region(OTHER), "old work")
    relay._clock.advance(5)
    relay.registry.acquire("r1", "sara", "a1", region(CONTESTED), "refactor")

    tools = _tools(relay, "a2", "dev")
    result = tools.claim_work(CONTESTED["path"], CONTESTED["symbol"], "rename")

    assert result["granted"] is False
    assert result["held_by"] == "a1"
    assert result["decision"] == "wait"
    assert holds(relay, "a2") == ["src/db.py"]


def test_the_tool_path_tells_the_younger_claimant_to_abort(relay):
    relay.registry.acquire("r1", "sara", "a1", region(CONTESTED), "refactor")
    relay._clock.advance(5)
    relay.registry.acquire("r1", "dev", "a2", region(OTHER), "side work")

    tools = _tools(relay, "a2", "dev")
    result = tools.claim_work(CONTESTED["path"], CONTESTED["symbol"], "rename")

    assert result["granted"] is False
    assert result["decision"] == "abort"
    assert holds(relay, "a2") == []
    assert holds(relay, "a1") == ["src/auth.py"]


def test_a_granted_tool_claim_carries_no_instruction(relay):
    tools = _tools(relay, "a2", "dev")
    assert tools.claim_work("src/db.py", "query", "add index") == {"granted": True}


def test_the_instruction_survives_the_dispatch_boundary(relay):
    # The model never calls claim_work directly; it comes in through dispatch.
    relay.registry.acquire("r1", "sara", "a1", region(CONTESTED), "refactor")
    relay._clock.advance(5)
    tools = _tools(relay, "a2", "dev")
    result = dispatch(tools, "claim_work", {
        "path": CONTESTED["path"], "symbol": CONTESTED["symbol"], "intent": "rename",
    })
    assert result["decision"] == "abort"


# -- the two channels have to agree ------------------------------------------


def _younger_claimant_setup() -> Relay:
    """a1 holds the contested region and is older; a2 holds something else."""
    r = Relay(VirtualClock(1000.0))
    r.registry.acquire("r1", "sara", "a1", region(CONTESTED), "refactor")
    r._clock.advance(5)
    r.registry.acquire("r1", "dev", "a2", region(OTHER), "side work")
    return r


def test_both_channels_give_the_same_claimant_the_same_instruction():
    # An agent that claims over the wire and one that claims through the tool
    # must not get different answers to the same question, or wait-die orders
    # the two channels differently and the cycle comes back.
    over_wire = _younger_claimant_setup()
    conn = FakeConn("a2", "dev")
    over_wire.join("r1", conn)
    wire = claim(over_wire, conn, CONTESTED)

    over_tool = _younger_claimant_setup()
    tool = _tools(over_tool, "a2", "dev").claim_work(
        CONTESTED["path"], CONTESTED["symbol"], "rename"
    )

    assert wire["decision"] == tool["decision"] == "abort"
    assert holds(over_wire, "a2") == holds(over_tool, "a2") == []
