"""A daemon reconciles against the relay on every (re)connect.

The relay is stateless across restarts on purpose, so a restarted one comes back
with an empty lease table. The daemon does not: its LeaseCache still holds
whatever it was told before the relay died, and it keeps blocking edits on it.

The frame that fixes that is the join snapshot, and it has to be sent even when
it is empty. "Nothing held" is a fact about the authority; silence is not.
Without it a daemon waits out the 90 second TTL for a lease nothing holds.
"""

from __future__ import annotations

import asyncio
import contextlib
import json

import pytest
import websockets

from agent_presence import serve as serve_mod
from agent_presence.clock import RealClock
from agent_presence.relay import Relay

ROOM = "restart-room"
REGION = {"path": "src/contested.py", "symbol": None, "lines": None}


@pytest.fixture(autouse=True)
def _opaque_off(monkeypatch):
    monkeypatch.delenv("AGENT_PRESENCE_OPAQUE", raising=False)


class RelayServer:
    def __init__(self, port: int = 0) -> None:
        self.relay = Relay(RealClock())
        self.port = port
        self._stop = asyncio.Event()
        self._task: asyncio.Task | None = None

    async def start(self) -> "RelayServer":
        loop = asyncio.get_running_loop()
        ready: asyncio.Future = loop.create_future()

        def on_ready(server) -> None:
            if not ready.done():
                ready.set_result(server.sockets[0].getsockname()[1])

        self._task = asyncio.create_task(
            serve_mod.serve("127.0.0.1", self.port, self.relay,
                            stop=self._stop, on_ready=on_ready)
        )
        self.port = await asyncio.wait_for(ready, timeout=5)
        return self

    @property
    def url(self) -> str:
        return f"ws://127.0.0.1:{self.port}"

    async def stop(self) -> None:
        """Closest thing to SIGKILL that leaves the port free for the next one."""
        self._stop.set()
        if self._task is not None:
            with contextlib.suppress(Exception):
                await asyncio.wait_for(self._task, timeout=5)


async def _recv(ws, kind: str, timeout: float = 3.0) -> dict:
    """The next frame of `kind`, skipping anything else on the way."""
    deadline = asyncio.get_running_loop().time() + timeout
    while True:
        left = deadline - asyncio.get_running_loop().time()
        if left <= 0:
            raise AssertionError(f"no {kind!r} frame arrived within {timeout}s")
        raw = await asyncio.wait_for(ws.recv(), timeout=left)
        frame = json.loads(raw)
        if frame.get("type") == kind:
            return frame


async def _join(ws, agent: str) -> None:
    await ws.send(json.dumps({"type": "join", "room": ROOM,
                              "agent": agent, "human": agent}))


async def test_a_join_into_an_empty_room_is_answered_with_an_empty_snapshot():
    server = await RelayServer().start()
    try:
        async with websockets.connect(server.url) as ws:
            await _join(ws, "a1")
            snapshot = await _recv(ws, "leases")
            assert snapshot["leases"] == []
    finally:
        await server.stop()


async def test_a_stale_lease_clears_on_reconnect_not_on_the_ttl():
    """Claim, kill the relay, restart it, reconnect. The daemon has to be told.

    `expires_in_ms` on the original grant is the 90 second TTL. The point of the
    test is that the clearing frame arrives in well under that, on the join,
    rather than the daemon sitting out the lease it cached.
    """
    first = await RelayServer().start()
    port = first.port
    try:
        async with websockets.connect(first.url) as holder, \
                   websockets.connect(first.url) as daemon:
            await _join(holder, "holder")
            await _join(daemon, "daemon")
            await asyncio.sleep(0.1)

            await holder.send(json.dumps({"type": "claim", "region": REGION,
                                          "intent": "held across the restart"}))
            granted = await _recv(holder, "claim_result")
            assert granted["granted"] is True
            assert granted["expires_in_ms"] > 80_000, "TTL is not the 90s one"

            # This is what the daemon caches and enforces on.
            held = await _recv(daemon, "lease")
            assert held["state"] == "held"
            assert held["region"]["path"] == REGION["path"]
    finally:
        await first.stop()

    second = await RelayServer(port).start()
    try:
        assert second.relay.registry.active_claims(ROOM) == [], (
            "a restarted relay is supposed to come back empty"
        )
        async with websockets.connect(second.url) as daemon:
            await _join(daemon, "daemon")
            snapshot = await _recv(daemon, "leases", timeout=3.0)
            assert snapshot["leases"] == [], (
                "the reconnecting daemon was never told the relay holds "
                "nothing, so it goes on blocking src/contested.py until its own "
                "copy ages out — up to 90 seconds after the relay came back"
            )
    finally:
        await second.stop()


async def test_a_reconnect_into_a_room_that_still_has_leases_gets_them_all():
    """The reconciliation is a replacement, so it must carry the live ones too."""
    server = await RelayServer().start()
    try:
        async with websockets.connect(server.url) as holder:
            await _join(holder, "holder")
            await holder.send(json.dumps({"type": "claim", "region": REGION,
                                          "intent": "still held"}))
            assert (await _recv(holder, "claim_result"))["granted"] is True

            async with websockets.connect(server.url) as daemon:
                await _join(daemon, "daemon")
                snapshot = await _recv(daemon, "leases")
                assert [e["agent"] for e in snapshot["leases"]] == ["holder"]
                assert snapshot["leases"][0]["intent"] == "still held"
    finally:
        await server.stop()
