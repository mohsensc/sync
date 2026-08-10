import asyncio
import contextlib
import json

import pytest
import websockets

from agent_presence.clock import RealClock
from agent_presence.principals import Principal, Roster, hash_token
from agent_presence.relay import Relay
from agent_presence.serve import serve

REGION = {"path": "src/auth.py", "symbol": "sign_in", "lines": None}

BOT_TOKEN = "release-bot-token"


class _Running:
    """A relay served on an ephemeral port, with what it takes to stop it."""

    def __init__(self, task: asyncio.Task, stop: asyncio.Event, url: str) -> None:
        self.task, self.stop, self.url = task, stop, url

    async def close(self) -> None:
        self.stop.set()
        with contextlib.suppress(asyncio.CancelledError):
            await asyncio.wait_for(self.task, timeout=5)


async def _start(relay) -> _Running:
    """Bind an ephemeral port and hand back its URL once it is actually bound.

    Fixed ports collide the instant two test suites run at once — that has
    already produced false failures for two different agents. Port 0 plus
    `on_ready` is the only way to learn the real port (see serve()'s own
    docstring), and it means there is no bind to race in the first place.
    """
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
    return _Running(task, stop, f"ws://127.0.0.1:{port}")


@pytest.fixture
async def server():
    relay = Relay(RealClock(), roster=Roster.inert())
    running = await _start(relay)
    yield relay, running.url
    await running.close()


@pytest.fixture
async def roster_server():
    """A relay with a roster, so the join frame's principal and token mean
    something. Its own ephemeral port, independent of any other fixture's."""
    roster = Roster(
        (Principal("release-bot", "Bot", 3, 3, hash_token(BOT_TOKEN)),),
        source="<test>", present=True,
    )
    relay = Relay(RealClock(), roster=roster)
    running = await _start(relay)
    yield relay, running.url
    await running.close()


async def recv(ws, kind, timeout=2, state=None):
    """The next frame of `kind` (and `state`, if given). A join is answered
    with a lease snapshot and a claim fans out to the room, so the socket
    carries more than one thing."""
    for _ in range(10):
        msg = json.loads(await asyncio.wait_for(ws.recv(), timeout=timeout))
        if msg.get("type") != kind:
            continue
        if state is None or msg.get("state") == state:
            return msg
    raise AssertionError(f"no {kind!r} frame arrived")


async def join(ws, agent, human, **extra):
    """Join and wait out the lease snapshot the relay answers it with.

    That snapshot is sent synchronously as part of the relay processing the
    join frame, so seeing it is proof the join has landed — the connection is
    a room member and reachable by fan-out. A fixed sleep here was standing in
    for that proof and guessing how long it takes; under real CPU pressure the
    guess is sometimes wrong and a fan-out assertion looks for a frame nobody
    was registered to receive yet.
    """
    frame = {"type": "join", "room": "r1", "agent": agent, "human": human}
    frame.update(extra)
    await ws.send(json.dumps(frame))
    return await recv(ws, "leases")


async def test_second_agent_learns_the_first_agents_intent_before_editing(server):
    """The whole product in one test: two agents, one region, and the second
    one is told who is there and what they are doing before it writes."""
    _, url = server
    async with websockets.connect(url) as sara, websockets.connect(url) as dev:
        await join(sara, "a1", "sara")
        await join(dev, "a2", "dev")

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
    _, url = server
    async with websockets.connect(url) as sara, websockets.connect(url) as dev:
        await join(sara, "a1", "sara")
        await join(dev, "a2", "dev")

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
    _, url = roster_server
    async with websockets.connect(url) as junior, websockets.connect(url) as bot:
        await join(junior, "a1", "dev")
        await join(bot, "a2", "ci", principal="release-bot", token=BOT_TOKEN)

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
    _, url = roster_server
    async with websockets.connect(url) as junior, websockets.connect(url) as liar:
        await join(junior, "a1", "dev")
        await join(liar, "a2", "mallory", principal="release-bot",
                   token="not-the-token")

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
    _, url = roster_server
    async with websockets.connect(url) as junior, websockets.connect(url) as liar:
        await join(junior, "a1", "dev")
        await join(liar, "a2", "mallory")

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
    _, url = roster_server
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


async def test_the_senior_agent_holds_its_place_and_the_junior_one_backs_off(
    roster_server,
):
    """The point of the roster, over a real socket.

    Two agents contend for a region a third already holds. Both arrive after the
    holder, so age alone would have both of them abort — the only difference
    between them is that one is in the roster. That one is told to `wait`, which
    means keep your place; the other is told to `abort`, which means drop
    everything and start over.

    Then the holder lets go, and the one that waited is the one that gets it.
    Nothing was ever taken off a live holder: there is no preemption here and
    priority did not add any.
    """
    _, url = roster_server
    region = {"path": "src/pay.py", "symbol": "charge", "lines": None}

    async with (
        websockets.connect(url) as holder,
        websockets.connect(url) as senior,
        websockets.connect(url) as junior,
    ):
        await join(holder, "a1", "nora")

        await holder.send(json.dumps({"type": "claim", "region": region,
                                      "intent": "rewriting the retry path"}))
        assert (await recv(holder, "claim_result"))["granted"] is True

        # Both challengers are younger than the holder.
        await join(senior, "a2", "sara", principal="release-bot", token=BOT_TOKEN,
                   unattended=True)
        await join(junior, "a3", "dev")

        for ws in (senior, junior):
            await ws.send(json.dumps({"type": "claim", "region": region,
                                      "intent": "work"}))

        senior_reply = await recv(senior, "claim_result")
        junior_reply = await recv(junior, "claim_result")

        assert senior_reply["granted"] is False
        assert junior_reply["granted"] is False
        # Same contest, same age, same holder. Only the roster differs.
        assert senior_reply["priority"] == "critical"
        assert junior_reply["priority"] == "normal"
        assert senior_reply["holder_priority"] == "normal"
        assert senior_reply["decision"] == "wait"
        assert junior_reply["decision"] == "abort"

        # The holder finishes. Whoever waited is still in the room and still
        # holds whatever it held; whoever aborted dropped everything. `release`
        # answers nothing on the holder's own socket — the room hears about it,
        # not the releaser — so what a test can wait on is the fan-out itself,
        # on whichever member is about to act on it.
        await holder.send(json.dumps({"type": "release", "region": region}))
        released = await recv(senior, "lease", state="released")
        assert released["agent"] == "a1"

        await senior.send(json.dumps({"type": "claim", "region": region,
                                      "intent": "hotfixing the outage"}))
        won = await recv(senior, "claim_result")
        assert won["granted"] is True
        assert won["priority"] == "critical"

        # And the junior one, asking at the same moment, is behind it now.
        await junior.send(json.dumps({"type": "claim", "region": region,
                                      "intent": "work"}))
        lost = await recv(junior, "claim_result")
        assert lost["granted"] is False
        assert lost["held_by"] == "a2"
        assert lost["holder_priority"] == "critical"
        assert lost["decision"] == "abort"


async def test_the_room_is_told_which_tier_a_lease_was_taken_at(roster_server):
    """The tier has to reach the *room*, not just the claimer.

    Every daemon renders what the relay pushes, so a lease body that leaves the
    tier out means `ap-hook` can name the holder and can never say they outrank
    you — which is the one thing that tells a blocked agent to wait rather than
    retry.
    """
    _, url = roster_server
    region = {"path": "src/pay.py", "symbol": "refund", "lines": None}

    async with (
        websockets.connect(url) as bot,
        websockets.connect(url) as watcher,
    ):
        await join(bot, "a1", "sara", principal="release-bot", token=BOT_TOKEN)
        await join(watcher, "a2", "dev")

        await bot.send(json.dumps({"type": "claim", "region": region,
                                   "intent": "cutting the release"}))
        assert (await recv(bot, "claim_result"))["granted"] is True

        # The fan-out the other daemon in the room receives.
        pushed = await recv(watcher, "lease")
        assert pushed["state"] == "held"
        assert pushed["agent"] == "a1"
        assert pushed["priority"] == "critical"

        # And a daemon that joins later gets it in the snapshot rather than
        # having to wait for the next change. Inside the holder's connection,
        # necessarily: hanging up releases what it held.
        async with websockets.connect(url) as latecomer:
            snapshot = await join(latecomer, "a3", "late")
            assert [e["priority"] for e in snapshot["leases"]] == ["critical"]
