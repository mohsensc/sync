import asyncio
import contextlib
import json

import pytest
import websockets

from agent_presence.clock import RealClock
from agent_presence.redact import opaque_region
from agent_presence.relay import Relay
from agent_presence.serve import serve
from agent_presence.types import Region


@pytest.fixture(autouse=True)
def _opaque_off(monkeypatch):
    monkeypatch.delenv("AGENT_PRESENCE_OPAQUE", raising=False)


@pytest.fixture
async def server():
    relay = Relay(RealClock())
    task = asyncio.create_task(serve("127.0.0.1", 8799, relay))
    await asyncio.sleep(0.2)
    yield relay
    task.cancel()
    # Await the cancel, otherwise the listening socket is still bound when the
    # next test tries to claim the port.
    with contextlib.suppress(asyncio.CancelledError):
        await task


async def test_two_clients_in_one_room_see_each_other(server):
    async with websockets.connect("ws://127.0.0.1:8799") as a, \
               websockets.connect("ws://127.0.0.1:8799") as b:
        for ws, agent in ((a, "a1"), (b, "a2")):
            await ws.send(json.dumps({"type": "join", "room": "r1",
                                      "agent": agent, "human": agent}))
        await asyncio.sleep(0.1)
        await a.send(json.dumps({
            "type": "event", "verb": "edit", "source": "hook",
            "region": {"path": "src/auth.py", "symbol": "sign_in", "lines": None},
        }))
        msg = json.loads(await asyncio.wait_for(b.recv(), timeout=2))
        assert msg["type"] == "presence"
        assert msg["agent"] == "a1"


async def test_malformed_json_does_not_kill_the_connection(server):
    async with websockets.connect("ws://127.0.0.1:8799") as ws:
        await ws.send(json.dumps({"type": "join", "room": "r1",
                                  "agent": "a1", "human": "sara"}))
        await ws.send("{not json")
        await ws.send(json.dumps({
            "type": "event", "verb": "read", "source": "hook",
            "region": {"path": "a.py", "symbol": None, "lines": None},
        }))
        reply = json.loads(await asyncio.wait_for(ws.recv(), timeout=2))
        assert reply["type"] == "ack"


async def test_join_without_a_room_does_not_kill_the_connection(server):
    async with websockets.connect("ws://127.0.0.1:8799") as ws:
        # No "room" key. Used to raise KeyError and close the socket with 1011.
        await ws.send(json.dumps({"type": "join", "agent": "a1", "human": "sara"}))
        await ws.send(json.dumps({"type": "join", "room": "r1",
                                  "agent": "a1", "human": "sara"}))
        await ws.send(json.dumps({
            "type": "event", "verb": "read", "source": "hook",
            "region": {"path": "a.py", "symbol": None, "lines": None},
        }))
        reply = json.loads(await asyncio.wait_for(ws.recv(), timeout=2))
        assert reply["type"] == "ack"
        assert ws.state is websockets.protocol.State.OPEN


async def test_join_with_a_non_string_room_is_dropped_not_fatal(server):
    async with websockets.connect("ws://127.0.0.1:8799") as ws:
        await ws.send(json.dumps({"type": "join", "room": {"content": "x"},
                                  "agent": "a1", "human": "sara"}))
        await ws.send(json.dumps({"type": "join", "room": "r1",
                                  "agent": "a1", "human": "sara"}))
        await ws.send(json.dumps({
            "type": "event", "verb": "read", "source": "hook",
            "region": {"path": "a.py", "symbol": None, "lines": None},
        }))
        reply = json.loads(await asyncio.wait_for(ws.recv(), timeout=2))
        assert reply["type"] == "ack"


async def test_opaque_mode_leaves_no_cleartext_path_on_the_wire(server, monkeypatch):
    monkeypatch.setenv("AGENT_PRESENCE_OPAQUE", "1")
    async with websockets.connect("ws://127.0.0.1:8799") as a, \
               websockets.connect("ws://127.0.0.1:8799") as b, \
               websockets.connect("ws://127.0.0.1:8799") as c:
        for ws, agent in ((a, "a1"), (b, "a2"), (c, "a3")):
            await ws.send(json.dumps({"type": "join", "room": "r1",
                                      "agent": agent, "human": agent}))
        await asyncio.sleep(0.1)

        await a.send(json.dumps({
            "type": "event", "verb": "edit", "source": "hook",
            "region": {"path": "src/auth.py", "symbol": "sign_in", "lines": [1, 9]},
        }))
        await asyncio.wait_for(a.recv(), timeout=2)  # a's own reply
        first = await asyncio.wait_for(b.recv(), timeout=2)
        await asyncio.wait_for(c.recv(), timeout=2)
        assert "auth" not in first
        assert "sign_in" not in first

        seen = json.loads(first)["region"]
        expected = opaque_region(
            Region(path="src/auth.py", symbol="sign_in", lines=None)
        )
        assert seen["path"] == expected.path
        assert seen["symbol"] == expected.symbol

        # Collision detection survives the hashing: same region compares equal,
        # a different one doesn't.
        await b.send(json.dumps({
            "type": "event", "verb": "edit", "source": "hook",
            "region": {"path": "src/auth.py", "symbol": "sign_in", "lines": [40, 80]},
        }))
        await asyncio.wait_for(b.recv(), timeout=2)  # b's own reply
        same = json.loads(await asyncio.wait_for(a.recv(), timeout=2))
        await asyncio.wait_for(c.recv(), timeout=2)
        assert same["region"]["path"] == seen["path"]

        await c.send(json.dumps({
            "type": "event", "verb": "edit", "source": "hook",
            "region": {"path": "src/db.py", "symbol": "sign_in", "lines": None},
        }))
        await asyncio.wait_for(c.recv(), timeout=2)  # c's own reply
        other = json.loads(await asyncio.wait_for(a.recv(), timeout=2))
        await asyncio.wait_for(b.recv(), timeout=2)
        assert other["region"]["path"] != seen["path"]
