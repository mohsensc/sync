"""A daemon reconciles against the relay on every (re)connect.

The relay is stateless across restarts on purpose, so a restarted one comes back
with an empty lease table. The daemon does not: its LeaseCache still holds
whatever it was told before the relay died, and it keeps blocking edits on it.

The frame that fixes that is the join snapshot, and it has to be sent even when
it is empty. "Nothing held" is a fact about the authority; silence is not.
Without it a daemon waits out the 90 second TTL for a lease nothing holds.

Runs against the real gorelay binary (helpers/gorelay_proc.py) — the one
in-process assertion the original version of this file had
(`relay.registry.active_claims(room) == []` on a bare Python Relay
object) has no analogue across a process boundary and isn't ported here;
it's a restatement of "a freshly constructed relay holds nothing," which
every Go leases_test.go fixture already demonstrates by construction
(NewRegistry starts with no claims, full stop — there's no code path that
could populate one before the first Acquire call). What this file actually
proves — that a *reconnecting* client is told the truth over the wire — is
the part with no analogue in a fresh in-process object, and it's the part
still exercised end to end below.
"""

from __future__ import annotations

import asyncio
import json
import pathlib
import sys

import pytest
import websockets

sys.path.insert(0, str(pathlib.Path(__file__).parent / "helpers"))
from gorelay_proc import start_gorelay  # noqa: E402

ROOM = "restart-room"
REGION = {"path": "src/contested.py", "symbol": None, "lines": None}


@pytest.fixture(autouse=True)
def _opaque_off(monkeypatch):
    monkeypatch.delenv("AGENT_PRESENCE_OPAQUE", raising=False)


async def _recv(ws, kind: str, timeout: float = 5.0) -> dict:
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


async def _join(ws, agent: str) -> dict:
    """Join and wait out the lease snapshot the relay answers it with.

    That snapshot is sent synchronously as part of the relay processing the
    join frame, so seeing it is proof the join has landed — the connection is
    a room member and reachable by fan-out. A fixed sleep here was standing in
    for that proof and guessing how long it takes; under real CPU pressure the
    guess is sometimes wrong and a claim fans out before the other daemon is
    actually a room member yet.
    """
    await ws.send(json.dumps({"type": "join", "room": ROOM,
                              "agent": agent, "human": agent}))
    return await _recv(ws, "leases")


async def test_a_join_into_an_empty_room_is_answered_with_an_empty_snapshot():
    proc = await start_gorelay()
    try:
        async with websockets.connect(proc.url) as ws:
            snapshot = await _join(ws, "a1")
            assert snapshot["leases"] == []
    finally:
        await proc.stop()


async def test_a_stale_lease_clears_on_reconnect_not_on_the_ttl():
    """Claim, kill the relay, restart it on the same port, reconnect. The
    daemon has to be told.

    `expires_in_ms` on the original grant is the 90 second TTL. The point of
    the test is that the clearing frame arrives in well under that, on the
    join, rather than the daemon sitting out the lease it cached.
    """
    first = await start_gorelay()
    port = first.port
    try:
        async with websockets.connect(first.url) as holder, \
                   websockets.connect(first.url) as daemon:
            await _join(holder, "holder")
            await _join(daemon, "daemon")

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

    second = await start_gorelay(port=port)
    try:
        async with websockets.connect(second.url) as daemon:
            snapshot = await _join(daemon, "daemon")
            assert snapshot["leases"] == [], (
                "the reconnecting daemon was never told the relay holds "
                "nothing, so it goes on blocking src/contested.py until its own "
                "copy ages out — up to 90 seconds after the relay came back"
            )
    finally:
        await second.stop()


async def test_a_reconnect_into_a_room_that_still_has_leases_gets_them_all():
    """The reconciliation is a replacement, so it must carry the live ones too."""
    proc = await start_gorelay()
    try:
        async with websockets.connect(proc.url) as holder:
            await _join(holder, "holder")
            await holder.send(json.dumps({"type": "claim", "region": REGION,
                                          "intent": "still held"}))
            assert (await _recv(holder, "claim_result"))["granted"] is True

            async with websockets.connect(proc.url) as daemon:
                snapshot = await _join(daemon, "daemon")
                assert [e["agent"] for e in snapshot["leases"]] == ["holder"]
                assert snapshot["leases"][0]["intent"] == "still held"
    finally:
        await proc.stop()
