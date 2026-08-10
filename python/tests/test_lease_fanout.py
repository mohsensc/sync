"""Leases have to reach the daemons that enforce them.

The relay granted a lease and answered the claimer. Nobody else in the room
ever heard about it, so every other daemon's LeaseCache stayed empty, every
hook lookup missed, and no agent was ever told to stop. These tests pin the
fan-out that makes the rest of the system reachable.

Frame shape is not a matter of taste here: cpp/daemon/relay_client.cpp parses
these fields by name in `on_text` and `upsert_lease`, and cpp/daemon/decide.cpp
answers hooks out of what lands in the cache. Anything asserted below is
asserted because the C++ reads it.
"""

import asyncio
import contextlib
import json

import pytest
import websockets

from agent_presence.clock import RealClock, VirtualClock
from agent_presence.leases import LEASE_TTL_S
from agent_presence.redact import opaque_outbound
from agent_presence.relay import Relay
from agent_presence.serve import serve

REGION = {"path": "src/auth.py", "symbol": "sign_in", "lines": None}
OTHER = {"path": "src/db.py", "symbol": "query", "lines": None}


class FakeConn:
    def __init__(self, agent, human):
        self.agent = agent
        self.human = human
        self.room = None
        self.sent = []

    def send(self, payload):
        self.sent.append(payload)


@pytest.fixture(autouse=True)
def _opaque_off(monkeypatch):
    monkeypatch.delenv("AGENT_PRESENCE_OPAQUE", raising=False)


@pytest.fixture
def relay():
    return Relay(VirtualClock(1000.0))


def claim(relay, conn, region=None, intent="work"):
    return relay.handle(conn, {"type": "claim", "region": region or REGION,
                               "intent": intent})


def frames(conn, kind, state=None):
    out = [f for f in conn.sent if f.get("type") == kind]
    if state is not None:
        out = [f for f in out if f.get("state") == state]
    return out


def region_key(frame):
    """The key cpp/daemon/relay_client.cpp builds: path + "|" + symbol, with a
    null symbol collapsing to the empty string."""
    region = frame["region"]
    symbol = region.get("symbol")
    return f"{region['path']}|{symbol if isinstance(symbol, str) else ''}"


# -- the missing broadcast ---------------------------------------------------


def test_a_granted_claim_reaches_every_other_member(relay):
    a, b = FakeConn("a1", "sara"), FakeConn("a2", "dev")
    relay.join("r1", a)
    relay.join("r1", b)

    claim(relay, a, intent="refactor to JWT")

    held = frames(b, "lease", "held")
    assert held, "the other daemon in the room never heard about the lease"
    assert len(held) == 1
    assert held[0]["agent"] == "a1"
    assert held[0]["human"] == "sara"
    assert held[0]["intent"] == "refactor to JWT"
    assert region_key(held[0]) == "src/auth.py|sign_in"


def test_the_lease_frame_carries_a_ttl_the_daemon_can_use(relay):
    """Relative, not absolute. LeaseCache is keyed off the daemon's monotonic
    clock and the relay stamps wall clock seconds; an absolute deadline on the
    wire expires every lease on arrival or none of them ever."""
    a, b = FakeConn("a1", "sara"), FakeConn("a2", "dev")
    relay.join("r1", a)
    relay.join("r1", b)

    claim(relay, a)

    frame = frames(b, "lease", "held")[0]
    assert frame["expires_in_ms"] == int(LEASE_TTL_S * 1000)
    assert frame["expires_at"] == 1000.0 + LEASE_TTL_S


def test_the_claimer_is_not_told_twice(relay):
    """It already gets claim_result on the same socket, and a client waiting on
    its own answer must not have to skip past its own fan-out to find it."""
    a, b = FakeConn("a1", "sara"), FakeConn("a2", "dev")
    relay.join("r1", a)
    relay.join("r1", b)

    claim(relay, a)

    assert frames(a, "lease") == []


def test_a_claim_does_not_leak_into_another_room(relay):
    a, b = FakeConn("a1", "sara"), FakeConn("a2", "dev")
    relay.join("r1", a)
    relay.join("r2", b)

    claim(relay, a)

    # b's own join snapshot is all it ever got, and that snapshot is r2's.
    assert [f.get("type") for f in b.sent] == ["leases"]
    assert b.sent[0]["leases"] == []


def test_the_claimers_own_result_carries_what_its_cache_needs(relay):
    """relay_client.cpp upserts a lease straight out of claim_result. Without a
    region on the frame there is nothing to key it by and the claimer's own
    cache stays empty."""
    a = FakeConn("a1", "sara")
    relay.join("r1", a)

    reply = claim(relay, a, intent="refactor")
    assert reply["granted"] is True
    assert region_key(reply) == "src/auth.py|sign_in"
    assert reply["expires_in_ms"] == int(LEASE_TTL_S * 1000)


def test_a_refused_claim_names_the_holder_in_a_cacheable_shape(relay):
    a, b = FakeConn("a1", "sara"), FakeConn("a2", "dev")
    relay.join("r1", a)
    relay.join("r1", b)
    claim(relay, a, intent="refactor to JWT")
    relay._clock.advance(5)

    reply = claim(relay, b, intent="rename")
    assert reply["granted"] is False
    assert reply["held_by"] == "a1"
    assert reply["human"] == "sara"          # what decide.cpp renders
    assert reply["intent"] == "refactor to JWT"
    assert region_key(reply) == "src/auth.py|sign_in"
    assert reply["expires_in_ms"] == int((LEASE_TTL_S - 5) * 1000)


# -- release frees the region for everyone else ------------------------------


def test_a_release_frame_goes_out_and_clears_the_block(relay):
    a, b = FakeConn("a1", "sara"), FakeConn("a2", "dev")
    relay.join("r1", a)
    relay.join("r1", b)
    claim(relay, a, intent="refactor")
    assert frames(b, "lease", "held")

    relay.handle(a, {"type": "release", "region": REGION})

    released = frames(b, "lease", "released")
    assert released, "the freed region still blocks every other daemon"
    assert released[0]["agent"] == "a1"
    assert region_key(released[0]) == "src/auth.py|sign_in"


def test_an_aborting_claimer_frees_what_it_gives_up(relay):
    """wait-die tells the loser to drop everything. If the drop is silent, the
    regions it abandoned keep blocking the whole room until they time out."""
    a, b, c = FakeConn("a1", "sara"), FakeConn("a2", "dev"), FakeConn("a3", "lee")
    relay.join("r1", a)
    relay.join("r1", b)
    relay.join("r1", c)

    claim(relay, a, intent="refactor")
    relay._clock.advance(5)
    claim(relay, b, region=OTHER, intent="side work")
    assert frames(c, "lease", "held")

    reply = claim(relay, b, intent="rename")
    assert reply["decision"] == "abort"

    freed = [f for f in frames(c, "lease", "released") if f["agent"] == "a2"]
    assert freed, "the aborted agent's leases were dropped without telling anyone"
    assert region_key(freed[0]) == "src/db.py|query"


def test_a_disconnect_frees_what_that_connection_held(relay):
    a, b = FakeConn("a1", "sara"), FakeConn("a2", "dev")
    relay.join("r1", a)
    relay.join("r1", b)
    claim(relay, a, intent="refactor")

    relay.leave(a)

    released = frames(b, "lease", "released")
    assert released, "a dropped connection's leases block the room until they expire"
    assert released[0]["agent"] == "a1"


def test_a_handoff_frees_the_region_it_hands_off(relay):
    a, b = FakeConn("a1", "sara"), FakeConn("a2", "dev")
    relay.join("r1", a)
    relay.join("r1", b)
    claim(relay, a, intent="refactor")

    relay.handle(a, {"type": "move", "region": REGION, "move": "HANDOFF"})

    assert frames(b, "lease", "released"), "HANDOFF dropped the lease silently"


# -- expiry ------------------------------------------------------------------


def test_a_renewed_lease_pushes_the_cached_deadline_out(relay):
    """The cache expires an entry on its own TTL, which is only safe while the
    relay's idea of the deadline and the daemon's agree. A heartbeat that is not
    broadcast makes them disagree, and the region stops being protected while
    the relay still thinks it is held."""
    a, b = FakeConn("a1", "sara"), FakeConn("a2", "dev")
    relay.join("r1", a)
    relay.join("r1", b)
    claim(relay, a, intent="refactor")

    relay._clock.advance(30)
    relay.handle(a, {"type": "heartbeat", "region": REGION})

    held = frames(b, "lease", "held")
    assert len(held) == 2, "a renewal never reached the room"
    assert held[-1]["expires_at"] == 1030.0 + LEASE_TTL_S
    assert held[-1]["expires_in_ms"] == int(LEASE_TTL_S * 1000)


def test_an_expired_lease_is_announced_as_well_as_timed_out(relay):
    a, b = FakeConn("a1", "sara"), FakeConn("a2", "dev")
    relay.join("r1", a)
    relay.join("r1", b)
    claim(relay, a, intent="refactor")

    relay._clock.advance(LEASE_TTL_S + 1)
    # Any registry touch prunes. The room hears about it on the next one.
    claim(relay, b, region=OTHER, intent="unrelated")

    gone = frames(b, "lease", "expired")
    assert gone, "an expired lease is only ever dropped locally, never announced"
    assert gone[0]["agent"] == "a1"
    assert region_key(gone[0]) == "src/auth.py|sign_in"


# -- a late joiner ------------------------------------------------------------


def test_a_joiner_is_handed_the_leases_it_missed(relay):
    """Incremental frames only reach whoever was already in the room. A daemon
    that connects after the claim would otherwise never learn about it."""
    a = FakeConn("a1", "sara")
    relay.join("r1", a)
    claim(relay, a, intent="refactor to JWT")

    b = FakeConn("a2", "dev")
    relay.join("r1", b)

    snapshots = frames(b, "leases")
    assert snapshots, "a late joiner starts with an empty cache and blocks nobody"
    entries = snapshots[0]["leases"]
    assert [e["agent"] for e in entries] == ["a1"]
    assert entries[0]["intent"] == "refactor to JWT"
    assert entries[0]["expires_in_ms"] == int(LEASE_TTL_S * 1000)
    assert region_key(entries[0]) == "src/auth.py|sign_in"


def test_an_empty_room_still_sends_an_authoritative_snapshot(relay):
    """The snapshot is what the daemon reconciles against, so silence is wrong.

    A relay restart comes back with an empty table. If the joiner hears nothing
    it keeps whatever it cached before the restart and goes on blocking edits
    for a lease nothing holds, until its own copy ages out — up to 90 seconds.
    An empty `leases` array is the frame that says "the authority holds none",
    and relay_client.cpp clears its table on it.
    """
    a = FakeConn("a1", "sara")
    relay.join("r1", a)
    snapshots = frames(a, "leases")
    assert snapshots, "a joiner must be told what the relay holds, even if nothing"
    assert snapshots[0]["leases"] == []


def test_a_rejoin_after_a_restart_clears_what_the_relay_no_longer_holds(relay):
    """The full cycle at relay level: claim, relay restarts, daemon rejoins.

    A restarted relay is a new Relay with an empty registry. The joiner's first
    frame has to be the empty snapshot, otherwise nothing tells it to drop the
    lease it is still enforcing.
    """
    a = FakeConn("a1", "sara")
    relay.join("r1", a)
    claim(relay, a, intent="held across the restart")
    assert frames(a, "leases")[0]["leases"] == []      # joined before the claim

    restarted = Relay(VirtualClock(2000.0))
    b = FakeConn("a1", "sara")
    restarted.join("r1", b)

    snapshots = frames(b, "leases")
    assert snapshots, "the restarted relay told the daemon nothing"
    assert snapshots[0]["leases"] == [], (
        "a stale lease survives the restart: the daemon has no frame telling it "
        "the relay holds nothing, so it blocks until the TTL runs out"
    )


# -- shape contract with cpp/daemon/relay_client.cpp -------------------------


def test_a_whole_file_lease_keys_the_way_the_daemon_keys_it(relay):
    """relay_client.cpp reads a null symbol as the empty string, and
    decide.cpp's conflict_for_file matches on the `path + "|"` prefix. A frame
    that omits `symbol` entirely keys the same way, but being explicit is what
    the C++ tests pin."""
    a, b = FakeConn("a1", "sara"), FakeConn("a2", "dev")
    relay.join("r1", a)
    relay.join("r1", b)

    claim(relay, a, region={"path": "src/db.py", "symbol": None, "lines": None})

    frame = frames(b, "lease", "held")[0]
    assert "symbol" in frame["region"]
    assert frame["region"]["symbol"] is None
    assert region_key(frame) == "src/db.py|"


def test_lease_frames_survive_json_and_the_outbound_scrubber(relay):
    a, b = FakeConn("a1", "sara"), FakeConn("a2", "dev")
    relay.join("r1", a)
    relay.join("r1", b)
    claim(relay, a, intent="refactor")

    frame = frames(b, "lease", "held")[0]
    wire = json.loads(json.dumps(opaque_outbound(frame)))
    assert wire["region"]["path"] == "src/auth.py"
    assert isinstance(wire["expires_in_ms"], int)


def test_opaque_mode_does_not_hash_a_lease_region_twice(monkeypatch):
    """The region reached the registry already hashed. Hashing it again on the
    way out gives every daemon a key the relay never arbitrates on."""
    monkeypatch.setenv("AGENT_PRESENCE_OPAQUE", "1")
    relay = Relay(VirtualClock(1000.0))
    a, b = FakeConn("a1", "sara"), FakeConn("a2", "dev")
    relay.join("r1", a)
    relay.join("r1", b)

    claim(relay, a, intent="refactor")

    frame = frames(b, "lease", "held")[0]
    before = frame["region"]["path"]
    after = opaque_outbound(frame)["region"]["path"]
    assert after == before, "opaque_outbound hashed an already-hashed path"
    assert "src/auth.py" not in json.dumps(opaque_outbound(frame))


# -- over a real socket ------------------------------------------------------

PORT = 8802


@pytest.fixture
async def server():
    relay = Relay(RealClock())
    task = asyncio.create_task(serve("127.0.0.1", PORT, relay))
    await asyncio.sleep(0.2)
    yield relay
    task.cancel()
    with contextlib.suppress(asyncio.CancelledError):
        await task


async def _join(ws, agent, human):
    await ws.send(json.dumps({"type": "join", "room": "r1",
                              "agent": agent, "human": human}))


async def _await_frame(ws, kind, state=None, tries=6):
    for _ in range(tries):
        msg = json.loads(await asyncio.wait_for(ws.recv(), timeout=2))
        if msg.get("type") != kind:
            continue
        if state is None or msg.get("state") == state:
            return msg
    return None


async def test_a_second_connection_receives_the_lease_over_the_wire(server):
    url = f"ws://127.0.0.1:{PORT}"
    async with websockets.connect(url) as sara, websockets.connect(url) as dev:
        await _join(sara, "a1", "sara")
        await _join(dev, "a2", "dev")
        await asyncio.sleep(0.1)

        await sara.send(json.dumps({"type": "claim", "region": REGION,
                                    "intent": "refactor to JWT"}))

        frame = await _await_frame(dev, "lease", "held")
        assert frame is not None, "the second daemon never saw the lease"
        assert frame["agent"] == "a1"
        assert frame["human"] == "sara"
        assert frame["intent"] == "refactor to JWT"
        assert frame["region"]["path"] == "src/auth.py"
        assert frame["region"]["symbol"] == "sign_in"
        assert frame["expires_in_ms"] > 0


async def test_a_release_reaches_the_second_connection_over_the_wire(server):
    url = f"ws://127.0.0.1:{PORT}"
    async with websockets.connect(url) as sara, websockets.connect(url) as dev:
        await _join(sara, "a1", "sara")
        await _join(dev, "a2", "dev")
        await asyncio.sleep(0.1)

        await sara.send(json.dumps({"type": "claim", "region": REGION,
                                    "intent": "refactor"}))
        assert await _await_frame(dev, "lease", "held") is not None

        await sara.send(json.dumps({"type": "release", "region": REGION}))

        frame = await _await_frame(dev, "lease", "released")
        assert frame is not None, "the freed region never unblocked anyone"
        assert frame["agent"] == "a1"
        assert frame["region"]["path"] == "src/auth.py"
        assert frame["region"]["symbol"] == "sign_in"
