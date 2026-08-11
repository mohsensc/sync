"""Privacy boundary, the paths redaction didn't cover.

`redact()` guards the event frame. Everything else a client can send — claim,
release, heartbeat, move — went into the relay raw, so the allowlist only ever
protected one of five frame types.
"""

import asyncio
import contextlib
import json

import pytest

from agent_presence.clock import RealClock, VirtualClock
from agent_presence.mcp_server import Tools
from agent_presence.redact import opaque_outbound
from agent_presence.relay import Relay
from agent_presence.relay_client import RelayConnection
from agent_presence.serve import serve

SECRET = "AKIAIOSFODNN7EXAMPLE-hunter2"
REGION = {"path": "src/auth.py", "symbol": "sign_in", "lines": None}


class FakeConn:
    def __init__(self, agent, human):
        self.agent = agent
        self.human = human
        self.room = None
        self.sent = []

    def send(self, payload):
        self.sent.append(payload)


@pytest.fixture(autouse=True)
def _opaque_off(monkeypatch):
    monkeypatch.delenv("AGENT_PRESENCE_OPAQUE", raising=False)


@pytest.fixture
def room():
    relay = Relay(VirtualClock(1000.0))
    a = FakeConn("a1", "sara")
    b = FakeConn("a2", "kai")
    relay.join("r1", a)
    relay.join("r1", b)
    return relay, a, b


def test_a_claim_intent_that_is_a_container_never_reaches_another_agent(room):
    """intent is opt-in free text. A dict parked under it is not intent, it is
    an envelope, and the relay hands it straight to whoever collides next."""
    relay, a, b = room
    relay.handle(a, {"type": "claim", "region": REGION,
                     "intent": {"prompt": SECRET, "stdout": SECRET}})
    reply = relay.handle(b, {"type": "claim", "region": REGION, "intent": "rename"})
    assert SECRET not in json.dumps(reply, default=str)


def test_a_move_reason_that_is_a_container_is_dropped(room, caplog):
    """PROCEED writes the reason into the relay's override log verbatim. Free
    text is the deal; a nested blob of model output is not."""
    relay, a, b = room
    relay.handle(a, {"type": "claim", "region": REGION, "intent": "work"})
    with caplog.at_level("WARNING", logger="agent_presence.negotiation"):
        relay.handle(b, {"type": "move", "region": REGION, "move": "PROCEED",
                         "reason": {"reasoning": SECRET}})
    assert SECRET not in caplog.text


def test_a_claim_with_an_unusable_region_is_dropped_not_guessed(room):
    relay, a, _ = room
    assert relay.handle(a, {"type": "claim", "region": {"path": {"c": SECRET}},
                            "intent": "work"}) is None
    assert relay.registry.active_claims("r1") == []


# -- opaque mode --------------------------------------------------------------


async def test_opaque_mode_hashes_regions_on_every_frame_not_just_events(monkeypatch):
    """The wire and MCP channels have to key the lease table the same way. When
    only one of them hashes, both agents get the same region granted."""
    monkeypatch.setenv("AGENT_PRESENCE_OPAQUE", "1")
    relay = Relay(RealClock())

    stop = asyncio.Event()
    loop = asyncio.get_running_loop()
    ready: asyncio.Future = loop.create_future()

    def on_ready(srv) -> None:
        if not ready.done():
            ready.set_result(srv.sockets[0].getsockname()[1])

    task = asyncio.create_task(
        serve("127.0.0.1", 0, relay, stop=stop, on_ready=on_ready)
    )
    port = await asyncio.wait_for(ready, timeout=5)
    url = f"ws://127.0.0.1:{port}"

    conn = RelayConnection(url, "r1", "a2", "kai")
    tools = Tools(conn, "r1", "a2", "kai")
    try:
        assert await tools.claim_work("src/auth.py", "sign_in", "mcp side") == {
            "granted": True
        }
        # Checked with a2's connection still open — closing it releases
        # everything a2 held (`Relay.leave`), which would let this claim
        # through for the wrong reason.
        a = FakeConn("a1", "sara")
        relay.join("r1", a)
        reply = relay.handle(a, {"type": "claim", "region": REGION, "intent": "wire side"})
    finally:
        await conn.close()

    assert reply["granted"] is False

    stop.set()
    with contextlib.suppress(asyncio.CancelledError):
        await asyncio.wait_for(task, timeout=5)


def test_opaque_mode_keeps_cleartext_paths_out_of_negotiation_errors(monkeypatch):
    """A rejected SPLIT names the contested region inside an error string.
    opaque_outbound cannot scrub a path that is already spliced into prose, so
    it has to have been hashed on the way in."""
    monkeypatch.setenv("AGENT_PRESENCE_OPAQUE", "1")
    relay = Relay(VirtualClock(1000.0))
    a = FakeConn("a1", "sara")
    b = FakeConn("a2", "kai")
    relay.join("r1", a)
    relay.join("r1", b)

    relay.handle(a, {"type": "claim",
                     "region": {"path": "src/very_secret_product.py",
                                "symbol": "launch", "lines": None},
                     "intent": "work"})
    reply = relay.handle(b, {"type": "move",
                             "region": {"path": "src/very_secret_product.py",
                                        "symbol": "launch", "lines": None},
                             "move": "SPLIT"})
    wire = json.dumps(opaque_outbound(reply))
    assert "very_secret_product" not in wire
    assert "launch" not in wire


def test_opaque_outbound_drops_a_container_parked_under_path(monkeypatch):
    """`path` holding a list is not a path the hasher can consume, and the old
    guard let the whole dict through untouched rather than dropping it."""
    monkeypatch.setenv("AGENT_PRESENCE_OPAQUE", "1")
    out = opaque_outbound({"type": "presence",
                           "path": ["/home/me/.ssh/id_rsa"],
                           "symbol": SECRET})
    assert SECRET not in json.dumps(out)
    assert "id_rsa" not in json.dumps(out)
