"""A subscriber that never reads.

The relay used to fire a task per outbound frame and park it in a module-level
set. A peer that never drains its socket never lets those finish, so the set and
every payload it pinned grew for as long as the peer stayed attached — 66 MB in
ten seconds under the load harness, and it was a rate, not a one-off.

The design goal that has to survive the fix: ingest does not stall. A slow peer
is allowed to cost that peer its frames and eventually its connection. It is
never allowed to cost anybody else anything.

None of these tests wait out a threshold. Shedding is measured on the relay's
injectable clock, so a test moves the clock and then waits on the *condition* it
cares about. What a test cannot fake is the precondition — a peer whose socket
has genuinely stopped draining — so the tests that need one drive to it and say
so loudly if they cannot reach it.
"""

from __future__ import annotations

import asyncio
import base64
import contextlib
import json
import os
import socket
import struct
import time
import types

import pytest
import websockets

from agent_presence import serve as serve_mod
from agent_presence.clock import RealClock, VirtualClock
from agent_presence.relay import Relay

ROOM = "slow-room"
# Big enough that a few hundred of them overrun a loopback socket buffer.
FAT_PATH = "src/" + ("d" * 4000) + "/f{}.py"

# How many frames a test is allowed to spend proving a socket has wedged. How
# many it actually takes is a property of the *sender's* kernel send buffer:
# about 250 on macOS loopback, about 625 on a Linux runner that autotunes wmem
# to 2.5 MB, and more on anything with a bigger one. This is a ceiling, not an
# expectation — the loop stops the moment the peer's queue starts dropping.
WEDGE_BUDGET = 6000


@pytest.fixture(autouse=True)
def _opaque_off(monkeypatch):
    monkeypatch.delenv("AGENT_PRESENCE_OPAQUE", raising=False)


@pytest.fixture(autouse=True)
def _tight_limits(monkeypatch):
    """Same mechanism, smaller numbers. These are clock seconds, not real ones:
    a test reaches them with `clock.advance`, so nothing here costs wall time."""
    monkeypatch.setattr(serve_mod, "SEND_QUEUE_MAX", 32, raising=False)
    monkeypatch.setattr(serve_mod, "SEND_STALL_S", 1.0, raising=False)
    monkeypatch.setattr(serve_mod, "SEND_SATURATED_S", 0.5, raising=False)


class RelayServer:
    """serve() on an ephemeral port, with the Relay object kept to hand."""

    def __init__(self, clock=None) -> None:
        self.clock = clock if clock is not None else RealClock()
        self.relay = Relay(self.clock)
        self.port = 0
        self._stop = asyncio.Event()
        self._task: asyncio.Task | None = None

    async def start(self) -> "RelayServer":
        loop = asyncio.get_running_loop()
        ready: asyncio.Future = loop.create_future()

        def on_ready(server) -> None:
            if not ready.done():
                ready.set_result(server.sockets[0].getsockname()[1])

        self._task = asyncio.create_task(
            serve_mod.serve("127.0.0.1", 0, self.relay,
                            stop=self._stop, on_ready=on_ready)
        )
        self.port = await asyncio.wait_for(ready, timeout=5)
        return self

    @property
    def url(self) -> str:
        return f"ws://127.0.0.1:{self.port}"

    def members(self, room: str = ROOM) -> list:
        return list(self.relay._members.get(room, []))

    async def stop(self) -> None:
        self._stop.set()
        if self._task is not None:
            with contextlib.suppress(Exception):
                await asyncio.wait_for(self._task, timeout=5)


@pytest.fixture
async def server():
    s = await RelayServer().start()
    yield s
    await s.stop()


@pytest.fixture
async def frozen_server():
    """A relay whose clock only moves when a test moves it."""
    s = await RelayServer(VirtualClock(0.0)).start()
    yield s
    await s.stop()


async def _until(cond, what: str, limit: float = 30.0) -> None:
    """Wait for a condition to hold. Not for a duration — `limit` only exists
    so a broken build fails instead of hanging, and no passing run goes near
    it."""
    deadline = time.perf_counter() + limit
    while time.perf_counter() < deadline:
        if cond():
            return
        await asyncio.sleep(0.01)
    raise AssertionError(what)


def _ws_text_frame(payload: bytes) -> bytes:
    mask = os.urandom(4)
    masked = bytes(b ^ mask[i % 4] for i, b in enumerate(payload))
    n = len(payload)
    if n < 126:
        head = struct.pack("!BB", 0x81, 0x80 | n)
    elif n < (1 << 16):
        head = struct.pack("!BBH", 0x81, 0x80 | 126, n)
    else:
        head = struct.pack("!BBQ", 0x81, 0x80 | 127, n)
    return head + mask + masked


class DeafPeer:
    """Completes the upgrade, joins, then never reads a byte again.

    The small SO_RCVBUF shuts this end's window early where the kernel honours
    it (Linux does, macOS ignores it on loopback), which is a nudge and not the
    trick: what actually wedges the relay is its own send buffer filling up
    behind a window that never reopens, and that buffer is sized by the sending
    kernel, not by anything this class can set. So no test here assumes a frame
    count reaches that point — they watch for it.

    Built on a worker thread: the relay shares this process's event loop, and a
    blocking recv on the loop's own thread would deadlock the handshake.
    """

    def __init__(self, port: int, agent: str = "deaf-agent") -> None:
        self.s = socket.create_connection(("127.0.0.1", port), 10)
        self.s.setsockopt(socket.SOL_SOCKET, socket.SO_RCVBUF, 2048)
        key = base64.b64encode(os.urandom(16)).decode()
        self.s.sendall(
            f"GET / HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nUpgrade: websocket\r\n"
            f"Connection: Upgrade\r\nSec-WebSocket-Key: {key}\r\n"
            f"Sec-WebSocket-Version: 13\r\n\r\n".encode()
        )
        self.s.settimeout(10)
        buf = b""
        while b"\r\n\r\n" not in buf:
            chunk = self.s.recv(4096)
            if not chunk:
                raise RuntimeError("relay refused the raw upgrade")
            buf += chunk
        self.s.sendall(_ws_text_frame(json.dumps(
            {"type": "join", "room": ROOM, "agent": agent, "human": "deaf"}
        ).encode()))

    def close(self) -> None:
        with contextlib.suppress(Exception):
            self.s.close()


async def _join(ws, agent: str) -> None:
    """Join and wait out the lease snapshot the relay answers it with.

    That snapshot is sent synchronously as part of the relay processing the
    join frame, so seeing it is proof the join has landed — the connection is
    a room member and reachable by fan-out. A fixed sleep here was standing in
    for that proof and guessing how long it takes; under real CPU pressure the
    guess is sometimes wrong and a healthy subscriber starts getting measured
    before it is actually a member of the room.
    """
    await ws.send(json.dumps({"type": "join", "room": ROOM,
                              "agent": agent, "human": agent}))
    while True:
        frame = json.loads(await asyncio.wait_for(ws.recv(), timeout=5))
        if frame.get("type") == "leases":
            return


def _event(n: int) -> str:
    return json.dumps({
        "type": "event", "verb": "edit", "source": "hook",
        "region": {"path": FAT_PATH.format(n), "symbol": None, "lines": None},
    })


async def _reader(ws, sink: list) -> None:
    with contextlib.suppress(Exception):
        async for raw in ws:
            frame = json.loads(raw)
            if frame.get("type") == "presence":
                sink.append(frame["region"]["path"])


async def _attach_deaf(server) -> tuple[DeafPeer, object]:
    deaf = await asyncio.to_thread(DeafPeer, server.port)
    await _until(
        lambda: any(c.agent == "deaf-agent" for c in server.members()),
        "the deaf peer never joined; test is not testing",
    )
    return deaf, next(c for c in server.members() if c.agent == "deaf-agent")


class Blast:
    """What one run of `_blast_until_dropping` saw."""

    def __init__(self, sent: int, worst_ack_ms: float, depths: list[int]) -> None:
        self.sent = sent
        self.worst_ack_ms = worst_ack_ms
        self.depths = depths


async def _blast_until_dropping(blaster, deaf_conn) -> Blast:
    """Feed the room until the deaf peer's queue is genuinely overflowing.

    This is the precondition every shedding assertion here depends on, and it
    is the thing a fixed frame count gets wrong: 400 fat frames is 1.6 MB, over
    the ~1 MB that wedges a macOS loopback socket and well under the 2.5 MB that
    wedges a Linux one, so the same number is a pass on a laptop and a no-op on
    a runner. Drive to the condition instead, and fail loudly if it turns out to
    be unreachable rather than quietly asserting on a peer that is fine.
    """
    worst_ack_ms = 0.0
    depths: list[int] = []
    sent = 0
    while sent < WEDGE_BUDGET:
        t0 = time.perf_counter()
        await blaster.send(_event(sent))
        await asyncio.wait_for(blaster.recv(), timeout=5)
        worst_ack_ms = max(worst_ack_ms, (time.perf_counter() - t0) * 1000)
        depths.append(len(deaf_conn._queue))
        sent += 1
        if sent % 25 == 0:
            await asyncio.sleep(0)
        if deaf_conn.dropped:
            return Blast(sent, worst_ack_ms, depths)
    raise AssertionError(
        f"{WEDGE_BUDGET} fat frames and the deaf peer's socket still took "
        f"everything: queue peaked at {max(depths)} and dropped nothing, so "
        f"there is no backlog here to shed and this test proves nothing. Its "
        f"send buffer is bigger than the budget, not the relay's problem."
    )


async def test_a_peer_that_never_reads_is_shed_and_nobody_else_notices(frozen_server):
    """The whole finding in one test: bounded cost, live neighbours, live ingest."""
    server = frozen_server
    async with websockets.connect(server.url) as healthy, \
               websockets.connect(server.url) as blaster:
        await _join(healthy, "healthy")
        await _join(blaster, "blaster")

        deaf, deaf_conn = await _attach_deaf(server)

        seen: list[str] = []
        pump = asyncio.create_task(_reader(healthy, seen))

        assert hasattr(deaf_conn, "_queue"), (
            "the connection carries no bounded send queue, so there is nowhere "
            "for a non-reading peer's backlog to be dropped"
        )

        blast = await _blast_until_dropping(blaster, deaf_conn)

        # Ingest never stalled. This is the property the fail-open design buys
        # and the one the old fire-and-forget code did get right.
        assert blast.worst_ack_ms < 2000, (
            f"a deaf subscriber stalled ingest: worst event ack "
            f"{blast.worst_ack_ms:.0f}ms"
        )

        # Bounded cost. The backlog is the thing that used to be unbounded.
        assert max(blast.depths) <= serve_mod.SEND_QUEUE_MAX, (
            f"the deaf subscriber's send queue reached {max(blast.depths)} "
            f"frames, over the {serve_mod.SEND_QUEUE_MAX} cap: nothing bounds it"
        )

        # And the healthy subscriber kept up the whole time, while the deaf one
        # was busy dropping frames on the floor.
        last = FAT_PATH.format(blast.sent - 1)
        await _until(
            lambda: last in seen,
            f"the healthy subscriber never got the last of {blast.sent} frames "
            f"while a deaf peer was attached: it fell behind and stayed behind",
        )
        pump.cancel()
        with contextlib.suppress(asyncio.CancelledError):
            await pump
        assert len(seen) > blast.sent * 0.75, (
            f"the healthy subscriber only got {len(seen)} of {blast.sent} "
            f"frames while a deaf peer was attached"
        )

        # The peer that will not read loses its connection rather than the relay
        # losing its memory. Nothing has slept for this: the deadline is clock
        # seconds, so move the clock past it and watch.
        assert deaf_conn in server.members(), (
            "the deaf peer was shed before its own deadline came round"
        )
        server.clock.advance(serve_mod.SEND_STALL_S + 1)
        await _until(
            lambda: deaf_conn not in server.members(),
            "a subscriber whose socket stopped draining, well past both shed "
            "deadlines on the relay's own clock, is still attached: nothing "
            "sheds it and its backlog is the relay's problem forever",
        )

        deaf.close()


async def test_a_shed_subscribers_leases_are_released(frozen_server):
    """Shedding goes through the ordinary disconnect path, lease release and all."""
    server = frozen_server
    async with websockets.connect(server.url) as blaster:
        await _join(blaster, "blaster")
        deaf, deaf_conn = await _attach_deaf(server)

        # The deaf peer takes a lease before it stops reading anything.
        deaf.s.sendall(_ws_text_frame(json.dumps({
            "type": "claim",
            "region": {"path": "src/contested.py", "symbol": None, "lines": None},
            "intent": "held by a peer that stopped listening",
        }).encode()))
        await _until(
            lambda: bool(server.relay.registry.active_claims(ROOM)),
            "the claim never landed",
        )

        await _blast_until_dropping(blaster, deaf_conn)

        # Two clock seconds, against a 90s lease TTL: the only thing that can
        # release this claim is the connection going away.
        server.clock.advance(serve_mod.SEND_STALL_S + 1)
        await _until(
            lambda: not server.relay.registry.active_claims(ROOM),
            "the shed subscriber's lease outlived its connection",
        )
        deaf.close()


async def test_a_healthy_subscriber_is_never_shed(server):
    """The threshold has to be about the peer, not about the traffic."""
    async with websockets.connect(server.url) as healthy, \
               websockets.connect(server.url) as blaster:
        await _join(healthy, "healthy")
        await _join(blaster, "blaster")

        seen: list[str] = []
        pump = asyncio.create_task(_reader(healthy, seen))
        for n in range(400):
            await blaster.send(_event(n))
            await asyncio.wait_for(blaster.recv(), timeout=5)
            if n % 25 == 0:
                await asyncio.sleep(0)
        await _until(lambda: len(seen) == 400,
                     f"the healthy subscriber got {len(seen)} of 400 frames")
        pump.cancel()
        with contextlib.suppress(asyncio.CancelledError):
            await pump

        assert any(c.agent == "healthy" for c in server.members()), (
            "a subscriber that read everything got disconnected anyway"
        )


# -- the deadline itself, with no sockets in the way -------------------------
#
# The tests above need a real wedged socket, which costs a few thousand frames
# and depends on a kernel buffer nobody controls. These two are the same
# decision with the socket replaced by a stub, so they pin the rule exactly:
# a send that does not finish inside SEND_STALL_S *clock* seconds is shed, and
# clock seconds passing on their own are not enough to shed anybody.


class _FakeWs:
    def __init__(self, *, stuck: bool) -> None:
        self.stuck = stuck
        self.sent: list[str] = []
        self.close_code: int | None = None
        self.aborted = False
        self.in_flight = 0
        self.transport = types.SimpleNamespace(
            abort=lambda: setattr(self, "aborted", True)
        )

    async def send(self, raw: str) -> None:
        self.in_flight += 1
        try:
            if self.stuck:
                await asyncio.Event().wait()   # a socket that never takes it
            self.sent.append(raw)
        finally:
            self.in_flight -= 1

    async def close(self, code: int = 1000, reason: str = "") -> None:
        self.close_code = code


def _presence(n: int) -> dict:
    return {"type": "presence", "human": "h", "agent": "a", "verb": "edit",
            "region": {"path": f"src/f{n}.py", "symbol": None, "lines": None}}


async def test_a_frame_that_will_not_leave_is_shed_on_clock_seconds():
    clock = VirtualClock(0.0)
    ws = _FakeWs(stuck=True)
    conn = serve_mod.WsConn(ws, asyncio.get_running_loop(), clock)

    conn.send(_presence(0))
    await _until(lambda: conn._sending_since is not None,
                 "the writer never got as far as the socket")

    # Real time is passing here and it buys nothing, which is the point.
    await asyncio.sleep(0.2)
    assert conn.shed_reason() is None, "shed on wall time, not on the clock"
    assert ws.close_code is None

    clock.advance(serve_mod.SEND_STALL_S)
    await _until(lambda: ws.close_code is not None,
                 "a frame stuck past SEND_STALL_S clock seconds was not shed")
    assert ws.close_code == 1013
    assert conn._closed and not conn._queue


async def test_time_alone_sheds_nobody():
    clock = VirtualClock(0.0)
    ws = _FakeWs(stuck=False)
    conn = serve_mod.WsConn(ws, asyncio.get_running_loop(), clock)

    for n in range(10):
        conn.send(_presence(n))
    # "Drained" means the writer task itself has finished, not merely that the
    # fake socket's mailbox has 10 entries. `_write`'s `finally` is what clears
    # `_sending_since`, and that runs as part of the writer task returning —
    # `ws.sent` gets its last append one step earlier, inside the same task but
    # before that return. Waiting on the mailbox instead of the task raced this
    # test against its own writer under load: `ws.sent` could read 10 while
    # `_sending_since` was still set from the last write, and the clock jump
    # right after landed inside that gap and shed a peer that had, in fact,
    # kept up.
    await _until(lambda: conn._writer is not None and conn._writer.done(),
                 "the writer never drained")
    assert len(ws.sent) == 10

    # A peer that keeps up is not on any deadline, however much time passes.
    clock.advance(serve_mod.SEND_STALL_S * 100)
    assert conn.shed_reason() is None
    conn.send(_presence(99))
    await _until(lambda: len(ws.sent) == 11, "a healthy peer stopped being served")
    assert ws.close_code is None and not conn._closed
    conn.shutdown()


async def test_a_cancelled_writer_leaves_no_send_behind():
    """The original leak, in miniature: a send nobody finishes and nobody drops."""
    ws = _FakeWs(stuck=True)
    conn = serve_mod.WsConn(ws, asyncio.get_running_loop(), VirtualClock(0.0))

    conn.send(_presence(0))
    await _until(lambda: ws.in_flight == 1, "the writer never reached the socket")

    conn.shutdown()   # what the session's `finally` does on any disconnect
    await _until(lambda: ws.in_flight == 0,
                 "the send outlived the writer that started it: an orphan task "
                 "pinning a payload for a connection that is already gone")
