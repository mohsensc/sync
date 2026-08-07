import asyncio
import contextlib
import json

import pytest
import websockets

from agent_presence.clock import RealClock
from agent_presence.relay import Relay
from agent_presence.serve import serve


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
