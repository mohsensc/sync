import asyncio
import contextlib
import json

import pytest
import websockets

from agent_presence.clock import RealClock
from agent_presence.relay import Relay
from agent_presence.serve import serve

PORT = 8801
REGION = {"path": "src/auth.py", "symbol": "sign_in", "lines": None}


@pytest.fixture
async def server():
    relay = Relay(RealClock())
    task = asyncio.create_task(serve("127.0.0.1", PORT, relay))
    await asyncio.sleep(0.2)
    yield relay
    task.cancel()
    # Awaiting the cancelled task is what actually closes the listening socket.
    # Without it the next test binds a port the old server is still holding and
    # its connections hang in the handshake.
    with contextlib.suppress(asyncio.CancelledError):
        await task


async def join(ws, agent, human):
    await ws.send(json.dumps({"type": "join", "room": "r1",
                              "agent": agent, "human": human}))


async def test_second_agent_learns_the_first_agents_intent_before_editing(server):
    """The whole product in one test: two agents, one region, and the second
    one is told who is there and what they are doing before it writes."""
    url = f"ws://127.0.0.1:{PORT}"
    async with websockets.connect(url) as sara, websockets.connect(url) as dev:
        await join(sara, "a1", "sara")
        await join(dev, "a2", "dev")
        await asyncio.sleep(0.1)

        # Sara's agent declares intent and takes the lease.
        await sara.send(json.dumps({"type": "claim", "agent": "a1", "human": "sara",
                                    "region": REGION, "intent": "refactor to JWT"}))
        first = json.loads(await asyncio.wait_for(sara.recv(), timeout=2))
        assert first["granted"] is True

        # Dev's agent tries to claim the same symbol.
        await dev.send(json.dumps({"type": "claim", "agent": "a2", "human": "dev",
                                   "region": REGION, "intent": "rename param"}))

        reply = None
        for _ in range(5):
            msg = json.loads(await asyncio.wait_for(dev.recv(), timeout=2))
            if msg.get("type") == "claim_result":
                reply = msg
                break

        assert reply is not None
        assert reply["granted"] is False
        assert reply["held_by"] == "a1"
        # The point of the entire system: the second agent is told the intent.
        assert reply["intent"] == "refactor to JWT"


async def test_no_double_edit_occurs_on_the_same_symbol(server):
    url = f"ws://127.0.0.1:{PORT}"
    async with websockets.connect(url) as sara, websockets.connect(url) as dev:
        await join(sara, "a1", "sara")
        await join(dev, "a2", "dev")
        await asyncio.sleep(0.1)

        for ws, agent in ((sara, "a1"), (dev, "a2")):
            await ws.send(json.dumps({"type": "claim", "agent": agent,
                                      "human": agent, "region": REGION,
                                      "intent": "work"}))

        granted = 0
        for ws in (sara, dev):
            msg = json.loads(await asyncio.wait_for(ws.recv(), timeout=2))
            if msg.get("type") == "claim_result" and msg.get("granted"):
                granted += 1

        assert granted == 1
