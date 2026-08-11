"""A peer that will not stop sending.

`test_backpressure.py` covers the outbound half: a subscriber that never
reads. This is the inbound twin — a connection that sends far more than any
real client does, and whether the rest of the room notices.

Same rule as the outbound tests: nothing here waits out a threshold on wall
time. The token bucket is read off the relay's injectable clock, so a test
drains it by sending frames and, if it needs the sustained-abuse branch,
advances the clock instead of sleeping.
"""

from __future__ import annotations

import asyncio
import contextlib
import json

import pytest
import websockets

from agent_presence import serve as serve_mod
from agent_presence.clock import VirtualClock

from test_backpressure import RelayServer, _join


@pytest.fixture(autouse=True)
def _opaque_off(monkeypatch):
    monkeypatch.delenv("AGENT_PRESENCE_OPAQUE", raising=False)


@pytest.fixture(autouse=True)
def _tight_inbound_limits(monkeypatch):
    """Small numbers, same mechanism. Refill is set near zero so a burst of
    sends against a frozen clock reliably empties the bucket and keeps it
    empty — the test does not depend on real wall-clock timing at all."""
    monkeypatch.setattr(serve_mod, "INBOUND_RATE_HZ", 0.001, raising=False)
    monkeypatch.setattr(serve_mod, "INBOUND_BURST", 3.0, raising=False)
    monkeypatch.setattr(serve_mod, "INBOUND_SATURATED_S", 0.5, raising=False)


@pytest.fixture
async def frozen_server():
    s = await RelayServer(VirtualClock(0.0)).start()
    yield s
    await s.stop()


def _event(path: str) -> str:
    return json.dumps({
        "type": "event", "verb": "edit", "source": "hook",
        "region": {"path": path, "symbol": None, "lines": None},
    })


async def _until(cond, what: str, limit: float = 10.0) -> None:
    import time
    deadline = time.perf_counter() + limit
    while time.perf_counter() < deadline:
        if cond():
            return
        await asyncio.sleep(0.01)
    raise AssertionError(what)


async def _recv_kind(ws, kind: str, timeout: float = 5) -> dict:
    """The next frame of `kind`, skipping the room's other traffic — the
    flooder's admitted frames still fan out to `healthy` as ordinary
    presence, and that is not what these assertions are about."""
    for _ in range(50):
        raw = await asyncio.wait_for(ws.recv(), timeout=timeout)
        msg = json.loads(raw)
        if msg.get("type") == kind:
            return msg
    raise AssertionError(f"no {kind!r} frame arrived")


async def test_a_flooding_peer_is_shed_without_stalling_a_healthy_neighbour(
    frozen_server,
):
    server = frozen_server
    async with websockets.connect(server.url) as healthy, \
               websockets.connect(server.url) as flooder:
        await _join(healthy, "healthy")
        # join itself spends the flooder's first token; INBOUND_BURST=3
        # leaves two more before the bucket runs dry.
        await flooder.send(json.dumps({
            "type": "join", "room": "slow-room",
            "agent": "flooder", "human": "flooder",
        }))
        while True:
            frame = json.loads(await asyncio.wait_for(flooder.recv(), timeout=5))
            if frame.get("type") == "leases":
                break

        flooder_conn = next(
            c for c in server.members() if c.agent == "flooder"
        )

        # Drain the rest of the burst, then keep hammering well past it. None
        # of this should reach the relay's own handling — dropped frames get
        # no ack — and it must not cost the healthy peer anything either.
        for i in range(20):
            await flooder.send(_event(f"src/flood{i}.py"))

        # The healthy peer, meanwhile, is answered normally: ingest for it
        # never stalled while the flooder was being throttled.
        await healthy.send(_event("src/healthy.py"))
        assert (await _recv_kind(healthy, "ack"))["type"] == "ack"

        assert flooder_conn.inbound_dropped > 0, (
            "a peer that sent far more than the burst allows had none of its "
            "frames dropped: the inbound token bucket is not gating anything"
        )
        assert flooder_conn in server.members(), (
            "shed before its own sustained-abuse deadline; the burst alone "
            "should only throttle, not disconnect"
        )

        # Sustained, not just bursty: keep sending while the clock crosses
        # the saturation deadline, and the connection should be dropped.
        server.clock.advance(serve_mod.INBOUND_SATURATED_S + 0.1)
        with contextlib.suppress(Exception):
            await flooder.send(_event("src/flood-final.py"))

        await _until(
            lambda: flooder_conn not in server.members(),
            "a connection that kept sending well past INBOUND_SATURATED_S "
            "worth of clock time is still a member: nothing sheds it and its "
            "flood is the relay's problem forever",
        )

        # And the healthy peer is still fine.
        await healthy.send(_event("src/healthy-2.py"))
        assert (await _recv_kind(healthy, "ack"))["type"] == "ack"


async def test_an_oversized_frame_is_rejected(frozen_server):
    server = frozen_server
    huge_room = "r" * (serve_mod.MAX_FRAME_BYTES + 1024)
    async with websockets.connect(server.url) as ws:
        with pytest.raises(websockets.exceptions.ConnectionClosed):
            await ws.send(json.dumps({
                "type": "join", "room": huge_room,
                "agent": "a1", "human": "sara",
            }))
            await ws.recv()
