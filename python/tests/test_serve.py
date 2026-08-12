import asyncio
import hashlib
import json
import pathlib
import sys

import pytest
import websockets

sys.path.insert(0, str(pathlib.Path(__file__).parent / "helpers"))
from gorelay_proc import start_gorelay  # noqa: E402


@pytest.fixture(autouse=True)
def _opaque_off(monkeypatch):
    monkeypatch.delenv("AGENT_PRESENCE_OPAQUE", raising=False)


def _opaque_hash(value: str) -> str:
    """Mirrors redact.py's `_h` for the one assertion here that needs it.
    redact.py is gone with the Python relay; this is the only remaining
    caller that cared about the hash shape, not the whole module."""
    return hashlib.sha256(value.encode()).hexdigest()[:16]


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


async def _joined(ws, room, agent, human):
    """Join and wait out the lease snapshot the relay answers it with.

    That snapshot is sent synchronously as part of the relay processing the
    join frame, so seeing it is proof the join has actually landed — the
    connection is a member of the room and can be fanned out to. A fixed sleep
    here was standing in for that proof and guessing at how long it takes; under
    real CPU pressure the guess is sometimes wrong and a fan-out test looks for
    a frame nobody was registered to receive yet.
    """
    await ws.send(json.dumps({"type": "join", "room": room,
                              "agent": agent, "human": human}))
    await recv(ws, "leases")


@pytest.fixture
async def server():
    proc = await start_gorelay()
    yield None, proc.url
    await proc.stop()


@pytest.fixture
async def opaque_server():
    """AGENT_PRESENCE_OPAQUE has to be set before the process starts — a
    child never observes a parent's later env change, which is exactly
    the harness artifact docs/relay-parity.md's black-box run hit doing
    this with monkeypatch.setenv mid-test against an already-spawned
    subprocess."""
    proc = await start_gorelay(env={"AGENT_PRESENCE_OPAQUE": "1"})
    yield None, proc.url
    await proc.stop()


async def test_two_clients_in_one_room_see_each_other(server):
    _, url = server
    async with websockets.connect(url) as a, \
               websockets.connect(url) as b:
        await _joined(a, "r1", "a1", "a1")
        await _joined(b, "r1", "a2", "a2")
        await a.send(json.dumps({
            "type": "event", "verb": "edit", "source": "hook",
            "region": {"path": "src/auth.py", "symbol": "sign_in", "lines": None},
        }))
        _, msg = await recv(b, "presence")
        assert msg["agent"] == "a1"


async def test_malformed_json_does_not_kill_the_connection(server):
    _, url = server
    async with websockets.connect(url) as ws:
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
    _, url = server
    async with websockets.connect(url) as ws:
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
    _, url = server
    async with websockets.connect(url) as ws:
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
    _, url = server
    async with websockets.connect(url) as ws:
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


async def test_opaque_mode_leaves_no_cleartext_path_on_the_wire(opaque_server):
    _, url = opaque_server
    async with websockets.connect(url) as a, \
               websockets.connect(url) as b, \
               websockets.connect(url) as c:
        await _joined(a, "r1", "a1", "a1")
        await _joined(b, "r1", "a2", "a2")
        await _joined(c, "r1", "a3", "a3")

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
        assert seen["path"] == _opaque_hash("src/auth.py")
        assert seen["symbol"] == _opaque_hash("sign_in")

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
