"""The MCP tool surface, talking to a relay over a real websocket connection.

`Tools` used to hold a `Relay` object and mutate its registry in-process, so
every test in this file used to build a `Tools` around a bare `Relay` and call
its methods directly — which looked correct because it never left the
process. These all go over a real socket now, the same one `test_serve.py`'s
scripted clients use, and a couple of tests below exist specifically to prove
a second, independent connection sees what the tool did.
"""

from __future__ import annotations

import asyncio
import contextlib
import json
from types import SimpleNamespace

import pytest
import websockets

from agent_presence.clock import RealClock, VirtualClock
from agent_presence.mcp_server import Tools, build_server, dispatch, tool_descriptors
from agent_presence.relay import Relay
from agent_presence.relay_client import RelayConnection
from agent_presence.serve import serve
from agent_presence.types import Region


@pytest.fixture(autouse=True)
def _opaque_off(monkeypatch):
    monkeypatch.delenv("AGENT_PRESENCE_OPAQUE", raising=False)


# -- wiring a relay onto a real socket ---------------------------------------


@contextlib.asynccontextmanager
async def running_relay(relay: Relay):
    """Serve `relay` on an ephemeral localhost port for the block, and hand
    back its ws:// url. Same shape as `test_serve.py`'s own `_start`."""
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
    try:
        yield f"ws://127.0.0.1:{port}"
    finally:
        stop.set()
        with contextlib.suppress(asyncio.CancelledError):
            await asyncio.wait_for(task, timeout=5)


async def _recv(ws, kind: str, timeout: float = 2) -> dict:
    for _ in range(10):
        msg = json.loads(await asyncio.wait_for(ws.recv(), timeout=timeout))
        if msg.get("type") == kind:
            return msg
    raise AssertionError(f"no {kind!r} frame arrived")


async def _wait_until(check, timeout: float = 2.0, interval: float = 0.005) -> bool:
    """Poll `check` until it's true or the budget runs out.

    Only for assertions with nothing to synchronize on: `release` gets no
    reply (see `Relay.publish` — the room hears about a change, not the
    connection that caused it), so there's no frame to await before the
    relay's own state is guaranteed to reflect it.
    """
    loop = asyncio.get_running_loop()
    deadline = loop.time() + timeout
    while True:
        if check():
            return True
        if loop.time() >= deadline:
            return False
        await asyncio.sleep(interval)


async def _wait_until_async(check, timeout: float = 2.0, interval: float = 0.005) -> bool:
    """Same as `_wait_until`, for a check that itself needs to await —
    `who_else_is_here` is a network call, not a local read."""
    loop = asyncio.get_running_loop()
    deadline = loop.time() + timeout
    while True:
        if await check():
            return True
        if loop.time() >= deadline:
            return False
        await asyncio.sleep(interval)


class FakeConn:
    """A room member with no MCP wrapper around it — for setting up state a
    real second peer would have caused (a competing holder, a hook event)
    without opening a second socket for every test."""

    def __init__(self, agent, human):
        self.agent, self.human, self.room, self.sent = agent, human, None, []

    def send(self, payload):
        self.sent.append(payload)


@pytest.fixture
async def setup():
    relay = Relay(RealClock())
    async with running_relay(relay) as url:
        peer = FakeConn("a1", "sara")
        relay.join("r1", peer)
        conn = RelayConnection(url, "r1", "a2", "dev")
        tools = Tools(conn, "r1", "a2", "dev")
        try:
            yield SimpleNamespace(relay=relay, tools=tools, peer=peer, url=url)
        finally:
            await conn.close()


async def test_who_else_is_here_is_empty_when_alone(setup):
    assert await setup.tools.who_else_is_here() == []


async def test_who_else_is_here_reports_other_agents(setup):
    # Forces the tool's connection to join before the event fires, so this
    # exercises the live `presence` frame path rather than the join
    # snapshot — see the test below for the snapshot.
    await setup.tools.who_else_is_here()
    setup.relay.handle(setup.peer, {
        "type": "event", "verb": "edit", "source": "hook",
        "region": {"path": "src/auth.py", "symbol": "sign_in", "lines": None},
    })
    peers: list[dict] = []

    async def _seen() -> bool:
        nonlocal peers
        peers = await setup.tools.who_else_is_here()
        return bool(peers)

    assert await _wait_until_async(_seen)
    assert peers[0]["human"] == "sara"
    assert peers[0]["path"] == "src/auth.py"


async def test_who_else_is_here_reports_activity_from_before_it_connected(setup):
    # The activity happens, and only then does the MCP session join. Before
    # the join snapshot carried `presence`, this session had no way to ever
    # learn about it — it starts after the one live `presence` frame this
    # event produced.
    setup.relay.handle(setup.peer, {
        "type": "event", "verb": "edit", "source": "hook",
        "region": {"path": "src/auth.py", "symbol": "sign_in", "lines": None},
    })
    peers = await setup.tools.who_else_is_here()
    assert peers[0]["human"] == "sara"
    assert peers[0]["path"] == "src/auth.py"


async def test_claim_work_grants_an_uncontested_region(setup):
    assert (await setup.tools.claim_work("src/db.py", "query", "add index"))["granted"]


async def test_claim_work_is_refused_and_names_the_holder(setup):
    setup.relay.registry.acquire(
        "r1", "sara", "a1", Region(path="src/db.py", symbol="query", lines=None),
        "rewriting query",
    )
    result = await setup.tools.claim_work("src/db.py", "query", "add index")
    assert not result["granted"]
    assert result["held_by"] == "a1"
    assert result["intent"] == "rewriting query"


async def test_release_frees_the_region_for_others(setup):
    await setup.tools.claim_work("src/db.py", "query", "add index")
    await setup.tools.release("src/db.py", "query")
    scope = Region(path="src/db.py", symbol="query", lines=None)
    assert await _wait_until(lambda: setup.relay.registry.holder_of("r1", scope) is None)


async def test_respond_refuses_an_invented_move_without_raising(setup):
    result = await setup.tools.respond("src/db.py", "query", "ARGUE")
    assert result["granted"] is False
    assert result["valid_moves"] == ["DEFER", "SPLIT", "HANDOFF", "PROCEED"]


async def test_proceed_is_always_granted_and_flagged_as_an_override(setup):
    setup.relay.registry.acquire(
        "r1", "sara", "a1", Region(path="src/db.py", symbol="query", lines=None), "x"
    )
    result = await setup.tools.respond("src/db.py", "query", "PROCEED", reason="unrelated")
    assert result["granted"]
    assert result["override"]


async def test_the_invented_move_is_named_in_the_error(setup):
    assert (await setup.tools.respond("src/db.py", "query", "ARGUE"))["error"] == (
        "unknown move: ARGUE"
    )


async def test_respond_accepts_moves_case_insensitively(setup):
    setup.relay.registry.acquire(
        "r1", "sara", "a1", Region(path="src/db.py", symbol="query", lines=None), "x"
    )
    result = await setup.tools.respond("src/db.py", "query", "  proceed  ", reason="unrelated")
    assert result["granted"]
    assert result["action"] == "proceed"
    assert "error" not in result


async def test_respond_keeps_the_tool_surface_total_for_every_junk_move(setup):
    for junk in ["", "   ", "ARGUE", "defer!", "PROCEE"]:
        result = await setup.tools.respond("src/db.py", "query", junk)
        assert result["granted"] is False
        assert result["valid_moves"] == ["DEFER", "SPLIT", "HANDOFF", "PROCEED"]


async def test_dispatch_returns_the_refusal_instead_of_raising_on_a_bad_move(setup):
    result = await dispatch(setup.tools, "respond", {
        "path": "src/db.py", "symbol": "query", "move": "ARGUE",
    })
    assert result["granted"] is False
    assert result["valid_moves"] == ["DEFER", "SPLIT", "HANDOFF", "PROCEED"]


async def test_opaque_mode_keys_tool_claims_the_way_hook_events_are_keyed(setup, monkeypatch):
    monkeypatch.setenv("AGENT_PRESENCE_OPAQUE", "1")
    from agent_presence.redact import opaque_region

    scope = opaque_region(Region(path="src/db.py", symbol="query", lines=None))
    setup.relay.registry.acquire("r1", "sara", "a1", scope, "rewriting query")
    # Same file, so the tool channel must land on the same lease the hook
    # channel took, hashed or not — the relay hashes both the same way now,
    # in `clean_region_dict`, because both arrive as wire frames.
    result = await setup.tools.claim_work("src/db.py", "query", "add index")
    assert not result["granted"]
    assert result["held_by"] == "a1"


async def test_opaque_mode_releases_the_hashed_scope(setup, monkeypatch):
    monkeypatch.setenv("AGENT_PRESENCE_OPAQUE", "1")
    from agent_presence.redact import opaque_region

    await setup.tools.claim_work("src/db.py", "query", "add index")
    await setup.tools.release("src/db.py", "query")
    scope = opaque_region(Region(path="src/db.py", symbol="query", lines=None))
    assert await _wait_until(lambda: setup.relay.registry.holder_of("r1", scope) is None)


def test_exactly_four_tools_are_exposed():
    assert [d["name"] for d in tool_descriptors()] == [
        "who_else_is_here", "claim_work", "release", "respond",
    ]


async def test_dispatch_routes_to_the_named_tool(setup):
    result = await dispatch(setup.tools, "claim_work", {
        "path": "src/db.py", "symbol": "query", "intent": "add index",
    })
    assert result["granted"]


async def test_dispatch_rejects_an_unknown_tool(setup):
    with pytest.raises(KeyError):
        await dispatch(setup.tools, "delete_everything", {})


async def test_the_mcp_server_lists_and_calls_the_four_tools(setup):
    from mcp.types import CallToolRequestParams

    server = build_server(setup.tools)

    listed = await server.get_request_handler("tools/list").handler(None, None)
    assert [t.name for t in listed.tools] == [
        "who_else_is_here", "claim_work", "release", "respond",
    ]

    call = server.get_request_handler("tools/call").handler
    result = await call(None, CallToolRequestParams(
        name="claim_work",
        arguments={"path": "src/db.py", "symbol": "query", "intent": "add index"},
    ))
    assert json.loads(result.content[0].text) == {"granted": True}


# -- crossing a real connection boundary -------------------------------------
#
# The bug this file used to have, structurally: every test above builds one
# `Tools` and asserts against the same `Relay` object it's plugged into.
# That's still true, and it's fine for domain coverage — but it can never
# catch "the claim never left the process", because in-process is exactly
# where it looks fine. These three don't touch `Tools`'s own relay reference
# at all; they open an independent websocket and check what a total stranger
# to this `Tools` instance sees.


async def test_a_claim_via_mcp_blocks_a_different_agents_edit_on_the_same_symbol():
    relay = Relay(RealClock())
    async with running_relay(relay) as url:
        conn = RelayConnection(url, "r1", "a1", "sara")
        tools = Tools(conn, "r1", "a1", "sara")
        try:
            granted = await tools.claim_work("src/auth.py", "sign_in", "refactor to JWT")
            assert granted == {"granted": True}

            async with websockets.connect(url) as other:
                await other.send(json.dumps({
                    "type": "join", "room": "r1", "agent": "a2", "human": "dev",
                }))
                await _recv(other, "leases")
                await other.send(json.dumps({
                    "type": "claim",
                    "region": {"path": "src/auth.py", "symbol": "sign_in", "lines": None},
                    "intent": "rename param",
                }))
                reply = await _recv(other, "claim_result")
        finally:
            await conn.close()

    assert reply["granted"] is False
    assert reply["held_by"] == "a1"
    # The point of the whole feature: the second connection is told the
    # first one's declared intent.
    assert reply["intent"] == "refactor to JWT"


async def test_a_claim_via_mcp_appears_in_another_daemons_lease_cache():
    """A daemon's `LeaseCache` is built entirely from the `leases` join
    snapshot and incremental `lease` frames (`cpp/daemon/relay_client.cpp`).
    A claim that never reaches a second connection's snapshot never reaches a
    daemon either — this is that check from the Python side."""
    relay = Relay(RealClock())
    async with running_relay(relay) as url:
        conn = RelayConnection(url, "r1", "a1", "sara")
        tools = Tools(conn, "r1", "a1", "sara")
        try:
            assert (await tools.claim_work(
                "src/auth.py", "sign_in", "refactor to JWT"
            ))["granted"]

            # A daemon joining *after* the claim still has to see it: the
            # relay reconciles a joiner from the lease snapshot, it doesn't
            # replay history.
            async with websockets.connect(url) as daemon:
                await daemon.send(json.dumps({
                    "type": "join", "room": "r1", "agent": "d1", "human": "dev",
                }))
                snapshot = await _recv(daemon, "leases")
        finally:
            await conn.close()

    assert len(snapshot["leases"]) == 1
    entry = snapshot["leases"][0]
    assert entry["agent"] == "a1"
    assert entry["region"]["path"] == "src/auth.py"
    assert entry["intent"] == "refactor to JWT"


async def test_respond_split_takes_the_same_path_the_wire_move_frame_does():
    """SPLIT acquires a disjoint sub-region for the requester. Proving it
    went over the wire rather than into a private table: a claim from a
    second, independent connection for that sub-region is refused
    afterward, exactly as it would be if a scripted client had sent the
    `move` frame `respond` sends under the hood."""
    relay = Relay(RealClock())
    async with running_relay(relay) as url:
        conn = RelayConnection(url, "r1", "a1", "sara")
        tools = Tools(conn, "r1", "a1", "sara")
        try:
            result = await tools.respond("src/db.py", "helper", "SPLIT")
            assert result["granted"] is True
            assert result["action"] == "split"

            async with websockets.connect(url) as other:
                await other.send(json.dumps({
                    "type": "join", "room": "r1", "agent": "a2", "human": "dev",
                }))
                await _recv(other, "leases")
                await other.send(json.dumps({
                    "type": "claim",
                    "region": {"path": "src/db.py", "symbol": "helper", "lines": None},
                    "intent": "steal it",
                }))
                reply = await _recv(other, "claim_result")
        finally:
            await conn.close()

    assert reply["granted"] is False
    assert reply["held_by"] == "a1"


# -- the tool channel is on the same roster as the wire channel --------------


def _roster():
    from agent_presence.principals import Principal, Roster, hash_token
    from agent_presence.priority import PRIORITY_NAMES

    return Roster(
        (Principal(id="sara", display="Sara",
                   attended=PRIORITY_NAMES["critical"],
                   unattended=PRIORITY_NAMES["critical"],
                   token_sha256=hash_token("s3cret")),),
        present=True, source="<test>",
    )


async def test_claim_work_claims_at_the_tier_the_roster_granted():
    # It used to stamp `normal` whatever the roster said, so an exec who put
    # themselves at critical and installed a token won contention through the
    # hook and lost it through the tools, in the same session. Now both
    # channels latch the grant the same way: at join.
    from agent_presence.priority import name_of

    relay = Relay(RealClock(), roster=_roster())
    async with running_relay(relay) as url:
        conn = RelayConnection(
            url, "r1", "presenced@exec", "sara",
            principal="sara", token="s3cret", unattended=True,
        )
        tools = Tools(conn, "r1", "presenced@exec", "sara")
        try:
            await tools.claim_work("src/pay.py", "charge", "hotfix")
            # Read while the connection is still open — closing it releases
            # everything it held, the same way a dropped connection always
            # does (`Relay.leave`), which would make this check pass for the
            # wrong reason.
            claim = relay.registry.holder_of(
                "r1", Region(path="src/pay.py", symbol="charge", lines=None)
            )
        finally:
            await conn.close()

    assert name_of(claim.priority) == "critical"


async def test_a_tool_session_with_no_token_is_still_normal():
    from agent_presence.priority import PRIORITY_NORMAL

    relay = Relay(RealClock(), roster=_roster())
    async with running_relay(relay) as url:
        conn = RelayConnection(url, "r1", "a2", "dev", principal="sara", token="")
        tools = Tools(conn, "r1", "a2", "dev")
        try:
            await tools.claim_work("src/pay.py", "charge", "hotfix")
            claim = relay.registry.holder_of(
                "r1", Region(path="src/pay.py", symbol="charge", lines=None)
            )
        finally:
            await conn.close()

    assert claim.priority == PRIORITY_NORMAL


async def test_claim_work_refused_by_a_reservation_says_when_to_come_back():
    from agent_presence.leases import HANDOVER_GRACE_S, HEARTBEAT_S
    from agent_presence.priority import PRIORITY_NAMES

    clock = VirtualClock(1000.0)
    relay = Relay(clock)
    scope = Region(path="src/pay.py", symbol="charge", lines=None)

    async with running_relay(relay) as url:
        conn = RelayConnection(url, "r1", "a2", "dev")
        tools = Tools(conn, "r1", "a2", "dev")
        try:
            # a2 holds it, a1 asks and is queued, a2's deadline fires.
            await tools.claim_work("src/pay.py", "charge", "work")
            relay.registry.acquire("r1", "sara", "a1", scope, "hotfix",
                                   priority=PRIORITY_NAMES["critical"])
            deadline = 1000.0 + HANDOVER_GRACE_S + 0.5
            while clock.now() < deadline:
                clock.advance(min(HEARTBEAT_S, deadline - clock.now()))
                relay.registry.heartbeat("r1", "a2", scope)

            answer = await tools.claim_work("src/pay.py", "charge", "work")
        finally:
            await conn.close()

    assert answer["granted"] is False
    assert answer["reserved"] is True
    assert answer["held_by"] == "a1"
    assert answer["retry_in_s"] > 0
    assert answer["moves"] == ["DEFER"]


async def test_claim_work_refused_by_a_holder_says_when_the_region_frees_up():
    relay = Relay(RealClock())
    scope = Region(path="src/pay.py", symbol="charge", lines=None)
    relay.registry.acquire("r1", "dev", "a1", scope, "long refactor")

    async with running_relay(relay) as url:
        conn = RelayConnection(url, "r1", "a2", "sara")
        tools = Tools(conn, "r1", "a2", "sara")
        try:
            answer = await tools.claim_work("src/pay.py", "charge", "hotfix")
        finally:
            await conn.close()

    assert answer["granted"] is False
    assert answer["held_by"] == "a1"
    assert answer["intent"] == "long refactor"
    # The number that turns DEFER from a shrug into an instruction.
    assert answer["handover_in_s"] > 0
    assert answer["retry_in_s"] == answer["handover_in_s"]
    assert answer["waiting"] == 1


# -- lifecycle: connect, reconnect, relay-not-running ------------------------
#
# An MCP server is long-lived — one process per Claude Code session, sitting
# idle between tool calls for as long as the session runs. A relay that was
# never started, or that dies mid-session, has to be a fast error on the next
# tool call, not a wedged one: a tool call that blocks forever is worse than
# one that errors.


async def _free_port() -> int:
    import socket

    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


async def test_claim_work_errors_instead_of_hanging_when_the_relay_is_not_running():
    port = await _free_port()
    conn = RelayConnection(
        f"ws://127.0.0.1:{port}", "r1", "a1", "sara",
        connect_timeout=1.0, request_timeout=1.0,
    )
    tools = Tools(conn, "r1", "a1", "sara")

    result = await asyncio.wait_for(
        tools.claim_work("src/db.py", "query", "add index"), timeout=3.0
    )
    assert result["granted"] is False
    assert "error" in result


async def test_release_and_who_else_is_here_also_dont_hang_with_no_relay():
    port = await _free_port()
    conn = RelayConnection(
        f"ws://127.0.0.1:{port}", "r1", "a1", "sara",
        connect_timeout=1.0, request_timeout=1.0,
    )
    tools = Tools(conn, "r1", "a1", "sara")

    released = await asyncio.wait_for(tools.release("src/db.py", "query"), timeout=3.0)
    assert released == {"released": False, "error": released["error"]}

    peers = await asyncio.wait_for(tools.who_else_is_here(), timeout=3.0)
    assert peers == []


async def test_a_dropped_connection_reconnects_on_the_next_tool_call():
    """The relay restarting mid-session is the same shape as it never having
    started: the next call has to notice and recover, not reuse a socket that
    is silently dead."""
    relay = Relay(RealClock())
    async with running_relay(relay) as url:
        conn = RelayConnection(url, "r1", "a1", "sara")
        tools = Tools(conn, "r1", "a1", "sara")
        try:
            assert (await tools.claim_work("src/db.py", "query", "first"))["granted"]

            # Simulate the socket dying under the connection without either
            # side sending a close frame — a relay crash, not a clean hangup.
            await conn._teardown()

            # The next call reconnects (a fresh join) and works normally.
            # It's a *different* connection now, so the region it already
            # holds under the old one is unaffected — this is only proving
            # the tool surface doesn't stay wedged on the dead socket.
            result = await asyncio.wait_for(
                tools.claim_work("src/other.py", None, "second"), timeout=3.0
            )
            assert result["granted"] is True
        finally:
            await conn.close()


async def test_respond_handoff_releases_for_a_second_connection():
    """HANDOFF releases the caller's own claim. Proving it went over the
    wire: a second, independent connection can claim the region afterward —
    the same shape as the SPLIT test above, for a different move."""
    relay = Relay(RealClock())
    async with running_relay(relay) as url:
        conn = RelayConnection(url, "r1", "a1", "sara")
        tools = Tools(conn, "r1", "a1", "sara")
        try:
            assert (await tools.claim_work("src/pay.py", "charge", "work"))["granted"]
            result = await tools.respond("src/pay.py", "charge", "HANDOFF")
            assert result["action"] == "handoff"

            async with websockets.connect(url) as other:
                await other.send(json.dumps({
                    "type": "join", "room": "r1", "agent": "a2", "human": "dev",
                }))
                await _recv(other, "leases")
                await other.send(json.dumps({
                    "type": "claim",
                    "region": {"path": "src/pay.py", "symbol": "charge", "lines": None},
                    "intent": "hotfix",
                }))
                reply = await _recv(other, "claim_result")
        finally:
            await conn.close()

    assert reply["granted"] is True


async def test_respond_defer_leaves_the_holders_claim_untouched():
    """DEFER never mutates the registry — it's the requester backing off.
    Going through `_negotiator.apply` on the relay proves it: the region a
    second connection holds is exactly as contested after as before."""
    relay = Relay(RealClock())
    async with running_relay(relay) as url:
        holder_conn = RelayConnection(url, "r1", "a1", "sara")
        holder = Tools(holder_conn, "r1", "a1", "sara")
        challenger_conn = RelayConnection(url, "r1", "a2", "dev")
        challenger = Tools(challenger_conn, "r1", "a2", "dev")
        try:
            assert (await holder.claim_work("src/pay.py", "charge", "work"))["granted"]
            result = await challenger.respond("src/pay.py", "charge", "DEFER")
            assert result == {"granted": False, "action": "defer", "override": False}

            still = await challenger.claim_work("src/pay.py", "charge", "still at it")
        finally:
            await holder_conn.close()
            await challenger_conn.close()

    assert still["granted"] is False
    assert still["held_by"] == "a1"
