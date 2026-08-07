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


async def recv(ws, kind, timeout=2):
    """The next frame of `kind`, skipping the rest.

    A join is answered with a lease snapshot — the frame a reconnecting daemon
    reconciles its cache against — so it is not the only thing on the socket.
    Returns (raw, parsed) so a test can still look at the bytes.
    """
    for _ in range(10):
        raw = await asyncio.wait_for(ws.recv(), timeout=timeout)
        msg = json.loads(raw)
        if msg.get("type") == kind:
            return raw, msg
    raise AssertionError(f"no {kind!r} frame arrived")


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
        _, msg = await recv(b, "presence")
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
        # recv is the assertion: an ack came back on a still-live socket.
        await recv(ws, "ack")


async def test_binary_frame_with_invalid_utf8_does_not_kill_the_connection(server):
    async with websockets.connect("ws://127.0.0.1:8799") as ws:
        await ws.send(json.dumps({"type": "join", "room": "r1",
                                  "agent": "a1", "human": "sara"}))
        # A binary frame arrives from `async for` as raw bytes and skips the
        # UTF-8 validation websockets does on text frames. json.loads then
        # raises UnicodeDecodeError, which is a ValueError but *not* a
        # JSONDecodeError, so it used to escape and close the socket with 1011.
        await ws.send(b"\x80not json")
        await ws.send(json.dumps({
            "type": "event", "verb": "read", "source": "hook",
            "region": {"path": "a.py", "symbol": None, "lines": None},
        }))
        _, reply = await recv(ws, "ack")
        assert ws.state is websockets.protocol.State.OPEN


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
        _, reply = await recv(ws, "ack")
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
        # recv is the assertion: an ack came back on a still-live socket.
        await recv(ws, "ack")


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
        await recv(a, "ack")                             # a's own reply
        first, _ = await recv(b, "presence")
        await recv(c, "presence")
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
        await recv(b, "ack")                             # b's own reply
        _, same = await recv(a, "presence")
        await recv(c, "presence")
        assert same["region"]["path"] == seen["path"]

        await c.send(json.dumps({
            "type": "event", "verb": "edit", "source": "hook",
            "region": {"path": "src/db.py", "symbol": "sign_in", "lines": None},
        }))
        await recv(c, "ack")                             # c's own reply
        _, other = await recv(a, "presence")
        await recv(b, "presence")
        assert other["region"]["path"] != seen["path"]
