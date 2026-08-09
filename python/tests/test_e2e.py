import asyncio
import contextlib
import json

import pytest
import websockets

from agent_presence.clock import RealClock
from agent_presence.principals import Principal, Roster, hash_token
from agent_presence.relay import Relay
from agent_presence.serve import serve

PORT = 8801
PRIORITY_PORT = 8802
REGION = {"path": "src/auth.py", "symbol": "sign_in", "lines": None}

BOT_TOKEN = "release-bot-token"


@pytest.fixture
async def server():
    relay = Relay(RealClock(), roster=Roster.inert())
    task = asyncio.create_task(serve("127.0.0.1", PORT, relay))
    await asyncio.sleep(0.2)
    yield relay
    task.cancel()
    # Awaiting the cancelled task is what actually closes the listening socket.
    # Without it the next test binds a port the old server is still holding and
    # its connections hang in the handshake.
    with contextlib.suppress(asyncio.CancelledError):
        await task


@pytest.fixture
async def roster_server():
    """A relay with a roster, so the join frame's principal and token mean
    something. Its own port: the other fixture's socket may not be down yet."""
    roster = Roster(
        (Principal("release-bot", "Bot", 3, 3, hash_token(BOT_TOKEN)),),
        source="<test>", present=True,
    )
    relay = Relay(RealClock(), roster=roster)
    task = asyncio.create_task(serve("127.0.0.1", PRIORITY_PORT, relay))
    await asyncio.sleep(0.2)
    yield relay
    task.cancel()
    with contextlib.suppress(asyncio.CancelledError):
        await task


async def join(ws, agent, human, **extra):
    frame = {"type": "join", "room": "r1", "agent": agent, "human": human}
    frame.update(extra)
    await ws.send(json.dumps(frame))


async def recv(ws, kind, timeout=2):
    """The next frame of `kind`. A join is answered with a lease snapshot and a
    claim fans out to the room, so the socket carries more than one thing."""
    for _ in range(10):
        msg = json.loads(await asyncio.wait_for(ws.recv(), timeout=timeout))
        if msg.get("type") == kind:
            return msg
    raise AssertionError(f"no {kind!r} frame arrived")


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
        first = await recv(sara, "claim_result")
        assert first["granted"] is True

        # Dev's agent tries to claim the same symbol.
        await dev.send(json.dumps({"type": "claim", "agent": "a2", "human": "dev",
                                   "region": REGION, "intent": "rename param"}))

        reply = await recv(dev, "claim_result")
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
            if (await recv(ws, "claim_result")).get("granted"):
                granted += 1

        assert granted == 1


# -- priority, over a real socket --------------------------------------------


async def test_an_authenticated_principal_gets_its_roster_tier(roster_server):
    """The join frame's principal and token are read, hashed and compared, and
    the resulting tier reaches the lease table."""
    url = f"ws://127.0.0.1:{PRIORITY_PORT}"
    async with websockets.connect(url) as junior, websockets.connect(url) as bot:
        await join(junior, "a1", "dev")
        await join(bot, "a2", "ci", principal="release-bot", token=BOT_TOKEN)
        await asyncio.sleep(0.1)

        await junior.send(json.dumps({"type": "claim", "region": REGION,
                                      "intent": "tidy up"}))
        assert (await recv(junior, "claim_result"))["granted"] is True

        await bot.send(json.dumps({"type": "claim", "region": REGION,
                                   "intent": "ship the release"}))
        reply = await recv(bot, "claim_result")

        # Not granted — nothing is ever taken off a live holder — but told to
        # wait rather than to abort, which is what priority buys.
        assert reply["granted"] is False
        assert reply["decision"] == "wait"
        assert reply["priority"] == "critical"
        assert reply["holder_priority"] == "normal"


async def test_a_join_frame_naming_a_principal_it_cannot_prove_gets_normal(
    roster_server,
):
    url = f"ws://127.0.0.1:{PRIORITY_PORT}"
    async with websockets.connect(url) as junior, websockets.connect(url) as liar:
        await join(junior, "a1", "dev")
        await join(liar, "a2", "mallory", principal="release-bot",
                   token="not-the-token")
        await asyncio.sleep(0.1)

        await junior.send(json.dumps({"type": "claim", "region": REGION,
                                      "intent": "tidy up"}))
        assert (await recv(junior, "claim_result"))["granted"] is True

        await liar.send(json.dumps({"type": "claim", "region": REGION,
                                    "intent": "steal the region"}))
        reply = await recv(liar, "claim_result")

        # Joined fine, claimed fine, lost anyway.
        assert reply["granted"] is False
        assert reply["decision"] == "abort"
        assert reply["priority"] == "normal"


async def test_a_claim_frame_cannot_carry_its_own_priority(roster_server):
    url = f"ws://127.0.0.1:{PRIORITY_PORT}"
    async with websockets.connect(url) as junior, websockets.connect(url) as liar:
        await join(junior, "a1", "dev")
        await join(liar, "a2", "mallory")
        await asyncio.sleep(0.1)

        await junior.send(json.dumps({"type": "claim", "region": REGION,
                                      "intent": "tidy up"}))
        assert (await recv(junior, "claim_result"))["granted"] is True

        await liar.send(json.dumps({"type": "claim", "region": REGION,
                                    "intent": "steal", "priority": "critical",
                                    "holder_priority": "background"}))
        reply = await recv(liar, "claim_result")

        assert reply["granted"] is False
        assert reply["decision"] == "abort"
        assert reply["priority"] == "normal"
        assert reply["holder_priority"] == "normal"


async def test_the_token_never_comes_back_out_on_the_wire(roster_server):
    url = f"ws://127.0.0.1:{PRIORITY_PORT}"
    async with websockets.connect(url) as bot:
        await join(bot, "a1", "ci", principal="release-bot", token=BOT_TOKEN)
        await bot.send(json.dumps({"type": "claim", "region": REGION,
                                   "intent": "work"}))
        seen = []
        for _ in range(4):
            try:
                seen.append(await asyncio.wait_for(bot.recv(), timeout=0.5))
            except asyncio.TimeoutError:
                break
        assert seen, "the relay said nothing at all"
        assert all(BOT_TOKEN not in frame for frame in seen)
