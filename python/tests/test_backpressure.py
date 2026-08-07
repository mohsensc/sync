"""A subscriber that never reads.

The relay used to fire a task per outbound frame and park it in a module-level
set. A peer that never drains its socket never lets those finish, so the set and
every payload it pinned grew for as long as the peer stayed attached — 66 MB in
ten seconds under the load harness, and it was a rate, not a one-off.

The design goal that has to survive the fix: ingest does not stall. A slow peer
is allowed to cost that peer its frames and eventually its connection. It is
never allowed to cost anybody else anything.
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

import pytest
import websockets

from agent_presence import serve as serve_mod
from agent_presence.clock import RealClock
from agent_presence.relay import Relay

ROOM = "slow-room"
# Big enough that a few hundred of them overrun a loopback socket buffer.
FAT_PATH = "src/" + ("d" * 4000) + "/f{}.py"


@pytest.fixture(autouse=True)
def _opaque_off(monkeypatch):
    monkeypatch.delenv("AGENT_PRESENCE_OPAQUE", raising=False)


@pytest.fixture(autouse=True)
def _tight_limits(monkeypatch):
    """Same mechanism, smaller numbers, so the test runs in seconds."""
    monkeypatch.setattr(serve_mod, "SEND_QUEUE_MAX", 32, raising=False)
    monkeypatch.setattr(serve_mod, "SEND_STALL_S", 1.0, raising=False)
    monkeypatch.setattr(serve_mod, "SEND_SATURATED_S", 0.5, raising=False)


class RelayServer:
    """serve() on an ephemeral port, with the Relay object kept to hand."""

    def __init__(self) -> None:
        self.relay = Relay(RealClock())
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

    A small SO_RCVBUF is the whole trick: the kernel window closes after a few
    KiB, so the relay's own buffering is what the test is measuring rather than
    the loopback socket's.

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
    await ws.send(json.dumps({"type": "join", "room": ROOM,
                              "agent": agent, "human": agent}))


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


async def test_a_peer_that_never_reads_is_shed_and_nobody_else_notices(server):
    """The whole finding in one test: bounded cost, live neighbours, live ingest."""
    async with websockets.connect(server.url) as healthy, \
               websockets.connect(server.url) as blaster:
        await _join(healthy, "healthy")
        await _join(blaster, "blaster")
        await asyncio.sleep(0.1)

        deaf = await asyncio.to_thread(DeafPeer, server.port)
        await asyncio.sleep(0.3)
        deaf_conns = [c for c in server.members() if c.agent == "deaf-agent"]
        assert len(deaf_conns) == 1, "the deaf peer never joined; test is not testing"
        deaf_conn = deaf_conns[0]

        seen: list[str] = []
        pump = asyncio.create_task(_reader(healthy, seen))

        assert hasattr(deaf_conn, "_queue"), (
            "the connection carries no bounded send queue, so there is nowhere "
            "for a non-reading peer's backlog to be dropped"
        )

        worst_ack_ms = 0.0
        depths: list[int] = []
        for n in range(400):
            t0 = time.perf_counter()
            await blaster.send(_event(n))
            await asyncio.wait_for(blaster.recv(), timeout=5)
            worst_ack_ms = max(worst_ack_ms, (time.perf_counter() - t0) * 1000)
            depths.append(len(deaf_conn._queue))
            if n % 25 == 0:
                await asyncio.sleep(0)

        # Ingest never stalled. This is the property the fail-open design buys
        # and the one the old fire-and-forget code did get right.
        assert worst_ack_ms < 2000, (
            f"a deaf subscriber stalled ingest: worst event ack {worst_ack_ms:.0f}ms"
        )

        # Bounded cost. The backlog is the thing that used to be unbounded.
        assert max(depths) <= serve_mod.SEND_QUEUE_MAX, (
            f"the deaf subscriber's send queue reached {max(depths)} frames, "
            f"over the {serve_mod.SEND_QUEUE_MAX} cap: nothing bounds it"
        )

        # The peer that will not read loses its connection rather than the
        # relay losing its memory.
        deadline = time.perf_counter() + 10
        while time.perf_counter() < deadline:
            if deaf_conn not in server.members():
                break
            await asyncio.sleep(0.1)
        else:
            raise AssertionError(
                "a subscriber that never read a byte for 400 fat frames is "
                "still attached: nothing sheds it and its backlog is the "
                "relay's problem forever"
            )

        # And the healthy subscriber kept up the whole time.
        pump.cancel()
        with contextlib.suppress(asyncio.CancelledError):
            await pump
        assert len(seen) > 300, (
            f"the healthy subscriber only got {len(seen)} of 400 frames while a "
            f"deaf peer was attached"
        )
        assert FAT_PATH.format(399) in seen, (
            "the healthy subscriber missed the last frame, so it fell behind "
            "and stayed behind"
        )

        deaf.close()


async def test_a_shed_subscribers_leases_are_released(server):
    """Shedding goes through the ordinary disconnect path, lease release and all."""
    async with websockets.connect(server.url) as blaster:
        await _join(blaster, "blaster")
        deaf = await asyncio.to_thread(DeafPeer, server.port)
        await asyncio.sleep(0.3)

        # The deaf peer takes a lease before it stops reading anything.
        deaf.s.sendall(_ws_text_frame(json.dumps({
            "type": "claim",
            "region": {"path": "src/contested.py", "symbol": None, "lines": None},
            "intent": "held by a peer that stopped listening",
        }).encode()))
        await asyncio.sleep(0.3)
        assert server.relay.registry.active_claims(ROOM), "the claim never landed"

        for n in range(400):
            await blaster.send(_event(n))
            await asyncio.wait_for(blaster.recv(), timeout=5)
            if n % 25 == 0:
                await asyncio.sleep(0)

        deadline = time.perf_counter() + 10
        while time.perf_counter() < deadline:
            if not server.relay.registry.active_claims(ROOM):
                break
            await asyncio.sleep(0.1)
        else:
            raise AssertionError(
                "the shed subscriber's lease outlived its connection"
            )
        deaf.close()


async def test_a_healthy_subscriber_is_never_shed(server):
    """The threshold has to be about the peer, not about the traffic."""
    async with websockets.connect(server.url) as healthy, \
               websockets.connect(server.url) as blaster:
        await _join(healthy, "healthy")
        await _join(blaster, "blaster")
        await asyncio.sleep(0.1)

        seen: list[str] = []
        pump = asyncio.create_task(_reader(healthy, seen))
        for n in range(400):
            await blaster.send(_event(n))
            await asyncio.wait_for(blaster.recv(), timeout=5)
            if n % 25 == 0:
                await asyncio.sleep(0)
        await asyncio.sleep(0.5)
        pump.cancel()
        with contextlib.suppress(asyncio.CancelledError):
            await pump

        assert any(c.agent == "healthy" for c in server.members()), (
            "a subscriber that read everything got disconnected anyway"
        )
        assert len(seen) == 400
