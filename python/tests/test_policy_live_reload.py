"""Live reload, in a system that is running.

`test_policy.py` covers `PolicyFile` on its own: the stat gate, the last-good
fallback, the problem lines. What it cannot cover is the thing the requirement
actually asks for — that editing a policy file changes what a *running* relay
does, with nothing restarted and no connection dropped, and that a typo in that
file does not take the relay down with it.

There are two halves and both are here:

  relay side   the org floor, re-read on the relay's own clock and pushed to
               every attached daemon as a `policy` frame
  daemon side  `cpp/daemon/policy_cache.cpp`, which stats one compiled blob on
               the tick it already runs. The contract between the two is a
               file format, so the last section of this file pins it.
"""

from __future__ import annotations

import asyncio
import contextlib
import json
import logging
import re
from pathlib import Path

import pytest
import websockets

from agent_presence.clock import RealClock, VirtualClock
from agent_presence.policy import (
    BUILTIN,
    BUILTIN_FLOOR,
    EFFECTS,
    RUNTIME_CACHE_NAME,
    PolicyFile,
    build_policy,
    builtin_layer,
    compile_runtime,
    discover,
    parse_layer,
    runtime_cache_path,
    write_runtime_cache,
)
from agent_presence.relay import Relay
from agent_presence.serve import serve

CPP = Path(__file__).resolve().parents[2] / "cpp"


# --------------------------------------------------------------------------
# helpers
# --------------------------------------------------------------------------


class Recorder:
    """A connection that keeps everything the relay pushes at it."""

    def __init__(self, agent: str, human: str = "sara") -> None:
        self.agent, self.human, self.room = agent, human, None
        self.sent: list[dict] = []

    def send(self, payload: dict) -> None:
        self.sent.append(payload)

    def frames(self, kind: str) -> list[dict]:
        return [f for f in self.sent if f.get("type") == kind]


def org_relay(tmp_path: Path, body: str | None = None):
    """A relay whose only policy input is an org file we control, on a clock we
    control. The policy clock is deliberately not the relay's: the test needs to
    step past RECHECK_S without also aging every lease."""
    path = tmp_path / "org.toml"
    if body is not None:
        path.write_text(body)
    policy_clock = VirtualClock(0.0)
    relay = Relay(
        VirtualClock(1000.0),
        policy=PolicyFile([("org", path)], policy_clock),
    )
    return relay, path, policy_clock


def floor_of(frame: dict) -> list[str]:
    return frame["floor"]


REGION = {"path": "src/auth.py", "symbol": "sign_in", "lines": None}


# --------------------------------------------------------------------------
# a running relay picks up a change
# --------------------------------------------------------------------------


def test_a_joiner_is_told_the_org_floor(tmp_path):
    relay, _path, _clock = org_relay(tmp_path, '[floor]\nrung3 = "deny"\n')
    conn = Recorder("a1")
    assert relay.join("r1", conn)

    frames = conn.frames("policy")
    assert len(frames) == 1
    assert floor_of(frames[0])[3] == "deny"
    assert frames[0]["source"].startswith("org:")
    assert frames[0]["digest"]

    # After the lease snapshot, so a daemon that replaces its whole lease table
    # on the snapshot has already done it by the time the floor arrives.
    kinds = [f["type"] for f in conn.sent]
    assert kinds.index("leases") < kinds.index("policy")


def test_a_relay_with_no_org_policy_puts_nothing_new_on_the_wire(tmp_path):
    """Installing this and configuring nothing has to be byte-for-byte what it
    was. A `policy` frame announcing the compiled-in floor would be a change to
    every install that asked for nothing."""
    relay, _path, _clock = org_relay(tmp_path, None)  # no file at all
    conn = Recorder("a1")
    assert relay.join("r1", conn)
    assert conn.frames("policy") == []


def test_a_running_relay_republishes_a_changed_floor(tmp_path):
    relay, path, clock = org_relay(tmp_path, '[floor]\nrung3 = "notify"\n')
    a, b = Recorder("a1"), Recorder("a2")
    relay.join("r1", a)
    relay.join("r1", b)
    assert floor_of(a.frames("policy")[-1])[3] == "notify"

    # The edit somebody makes at 3am.
    path.write_text('[floor]\nrung3 = "deny"\nrung1 = "context"\n')
    clock.advance(2.0)  # past RECHECK_S; nothing is restarted

    # The next frame anyone sends is enough to carry it to the whole room.
    relay.handle(a, {"type": "event", "verb": "edit", "region": REGION})

    for conn in (a, b):
        latest = conn.frames("policy")[-1]
        assert floor_of(latest)[3] == "deny"
        assert floor_of(latest)[1] == "context"

    # And the connections are the same ones. Nothing was dropped to do it.
    assert relay._members["r1"] == [a, b]


def test_the_new_floor_is_in_force_for_the_very_frame_that_noticed_it(tmp_path):
    """The republish happens before the frame is dispatched, so the answer this
    connection gets and the floor the room was just told cannot disagree."""
    # A lone agent touching a file nobody else is in is rung 0, so rung 0 is
    # what this floor has to be on for the answer to be observable.
    relay, path, clock = org_relay(tmp_path, '[floor]\nrung0 = "silent"\n')
    a = Recorder("a1")
    relay.join("r1", a)

    path.write_text('[floor]\nrung0 = "deny"\n')
    clock.advance(2.0)

    reply = relay.handle(a, {"type": "event", "verb": "edit", "region": REGION})
    assert reply["rung"] == 0
    assert reply["effect"] == "deny"
    assert floor_of(a.frames("policy")[-1])[0] == "deny"


def test_a_floor_is_republished_only_when_it_actually_changes(tmp_path):
    relay, path, clock = org_relay(tmp_path, '[floor]\nrung3 = "deny"\n')
    a = Recorder("a1")
    relay.join("r1", a)
    assert len(a.frames("policy")) == 1

    for _ in range(5):
        clock.advance(2.0)
        relay.handle(a, {"type": "event", "verb": "read", "region": REGION})
    assert len(a.frames("policy")) == 1

    # A comment is not a change either: the digest is over the rules.
    path.write_text('# why: payments\n[floor]\nrung3 = "deny"\n')
    clock.advance(2.0)
    relay.handle(a, {"type": "event", "verb": "read", "region": REGION})
    assert len(a.frames("policy")) == 1

    path.write_text('[floor]\nrung3 = "ask"\n')
    clock.advance(2.0)
    relay.handle(a, {"type": "event", "verb": "read", "region": REGION})
    assert len(a.frames("policy")) == 2


def test_a_joiner_after_the_change_gets_the_new_floor(tmp_path):
    relay, path, clock = org_relay(tmp_path, '[floor]\nrung3 = "notify"\n')
    a = Recorder("a1")
    relay.join("r1", a)

    path.write_text('[floor]\nrung3 = "deny"\n')
    clock.advance(2.0)

    late = Recorder("a2")
    relay.join("r1", late)
    assert floor_of(late.frames("policy")[-1])[3] == "deny"
    # And joining is itself enough to tell the room, so an idle relay is not
    # stuck on an old floor until somebody happens to edit something.
    assert floor_of(a.frames("policy")[-1])[3] == "deny"


def test_a_change_reaches_every_room_not_just_the_busy_one(tmp_path):
    relay, path, clock = org_relay(tmp_path, '[floor]\nrung3 = "notify"\n')
    a, b = Recorder("a1"), Recorder("a2")
    relay.join("r1", a)
    relay.join("r2", b)

    path.write_text('[floor]\nrung3 = "deny"\n')
    clock.advance(2.0)
    relay.handle(a, {"type": "event", "verb": "edit", "region": REGION})

    assert floor_of(b.frames("policy")[-1])[3] == "deny"


# --------------------------------------------------------------------------
# a malformed file does not take the relay down
# --------------------------------------------------------------------------


def test_a_typo_mid_run_keeps_the_last_good_floor_and_keeps_serving(tmp_path, caplog):
    relay, path, clock = org_relay(tmp_path, '[floor]\nrung3 = "deny"\n')
    a = Recorder("a1")
    relay.join("r1", a)

    path.write_text('[floor]\nrung3 = "deny\n')  # unterminated string
    clock.advance(2.0)

    with caplog.at_level(logging.WARNING):
        reply = relay.handle(
            a, {"type": "claim", "region": REGION, "intent": "refactor"}
        )

    # Still serving, and still on the floor it had.
    assert reply["granted"] is True
    policy = relay._policy.current()
    assert policy.floor_table("")[3] == "deny"
    assert policy.degraded
    # Loudly. A silent fallback is the failure this rule exists to prevent.
    assert any("TOML" in r.message or "TOML" in str(r.args) for r in caplog.records)


def test_a_typo_does_not_republish_a_weaker_floor(tmp_path):
    relay, path, clock = org_relay(tmp_path, '[floor]\nrung3 = "deny"\n')
    a = Recorder("a1")
    relay.join("r1", a)
    before = len(a.frames("policy"))

    path.write_text("this is not = = toml")
    clock.advance(2.0)
    relay.handle(a, {"type": "event", "verb": "edit", "region": REGION})

    for frame in a.frames("policy"):
        assert floor_of(frame)[3] == "deny"
    assert len(a.frames("policy")) == before  # nothing changed, so nothing was said


def test_a_typo_recovers_when_the_file_is_fixed(tmp_path):
    relay, path, clock = org_relay(tmp_path, '[floor]\nrung3 = "notify"\n')
    a = Recorder("a1")
    relay.join("r1", a)

    path.write_text("broken = = =")
    clock.advance(2.0)
    relay.handle(a, {"type": "event", "verb": "read", "region": REGION})
    assert relay._policy.current().degraded

    path.write_text('[floor]\nrung3 = "deny"\n')
    clock.advance(2.0)
    relay.handle(a, {"type": "event", "verb": "read", "region": REGION})

    policy = relay._policy.current()
    assert not policy.degraded
    assert floor_of(a.frames("policy")[-1])[3] == "deny"


def test_one_bad_key_mid_run_applies_the_rest(tmp_path):
    relay, path, clock = org_relay(tmp_path, '[floor]\nrung3 = "notify"\n')
    a = Recorder("a1")
    relay.join("r1", a)

    path.write_text('[floor]\nrung3 = "loud"\nrung1 = "context"\n')
    clock.advance(2.0)
    relay.handle(a, {"type": "event", "verb": "read", "region": REGION})

    latest = a.frames("policy")[-1]
    assert floor_of(latest)[1] == "context"  # the good key
    assert floor_of(latest)[3] == "notify"   # the bad one fell back to builtin
    assert relay._policy.current().degraded


def test_deleting_the_org_file_mid_run_keeps_the_relay_up(tmp_path):
    relay, path, clock = org_relay(tmp_path, '[floor]\nrung3 = "deny"\n')
    a = Recorder("a1")
    relay.join("r1", a)

    path.unlink()
    clock.advance(2.0)
    reply = relay.handle(a, {"type": "claim", "region": REGION, "intent": "x"})

    assert reply["granted"] is True
    # Back to the compiled-in floor, which every daemon already has, so there
    # is nothing to send and the last frame on the wire is still the old one.
    assert relay._policy.current().floor_table("")[3] == BUILTIN_FLOOR[3]


def test_a_degraded_org_policy_still_never_resolves_below_the_builtin_floor(tmp_path):
    relay, path, clock = org_relay(tmp_path, '[floor]\nrung3 = "silent"\n')
    a = Recorder("a1")
    relay.join("r1", a)

    for junk in ("= = =", "", '[floor]\nrung3 = 7\n', "[[floor]]\n"):
        path.write_text(junk)
        clock.advance(2.0)
        relay.handle(a, {"type": "event", "verb": "read", "region": REGION})
        table = relay._policy.current().floor_table("")
        for rung in range(5):
            assert EFFECTS.index(table[rung]) >= EFFECTS.index(BUILTIN_FLOOR[rung])


# --------------------------------------------------------------------------
# the same thing over a real socket, because the in-process relay above shares
# no code with `serve` and a frame that never reaches the wire is not a frame
# --------------------------------------------------------------------------


@pytest.fixture
async def live(tmp_path):
    """A relay on a real port, with an org policy we can edit under it."""
    path = tmp_path / "org.toml"
    path.write_text('[floor]\nrung3 = "notify"\n')
    clock = VirtualClock(0.0)
    relay = Relay(RealClock(), policy=PolicyFile([("org", path)], clock))

    bound: asyncio.Future[int] = asyncio.get_running_loop().create_future()
    stop = asyncio.Event()

    def ready(server):
        if not bound.done():
            bound.set_result(server.sockets[0].getsockname()[1])

    task = asyncio.create_task(serve("127.0.0.1", 0, relay, stop=stop, on_ready=ready))
    port = await asyncio.wait_for(bound, timeout=5)
    try:
        yield relay, path, clock, port
    finally:
        stop.set()
        task.cancel()
        with contextlib.suppress(asyncio.CancelledError):
            await task


async def _recv(ws, kind, timeout=3):
    for _ in range(20):
        msg = json.loads(await asyncio.wait_for(ws.recv(), timeout=timeout))
        if msg.get("type") == kind:
            return msg
    raise AssertionError(f"no {kind!r} frame arrived")


async def test_a_live_relay_pushes_a_changed_floor_without_restarting(live):
    relay, path, clock, port = live
    async with websockets.connect(f"ws://127.0.0.1:{port}") as ws:
        await ws.send(json.dumps({"type": "join", "room": "r1",
                                  "agent": "a1", "human": "sara"}))
        first = await _recv(ws, "policy")
        assert floor_of(first)[3] == "notify"

        # Edited while the socket stays open and the process stays up.
        path.write_text('[floor]\nrung3 = "deny"\n')
        clock.advance(2.0)

        await ws.send(json.dumps({"type": "event", "verb": "edit",
                                  "region": REGION}))
        second = await _recv(ws, "policy")
        assert floor_of(second)[3] == "deny"
        assert second["digest"] != first["digest"]

        # Same connection, still working: the ack for that event is still due.
        assert await _recv(ws, "ack")


async def test_a_live_relay_survives_a_broken_policy_file(live):
    relay, path, clock, port = live
    async with websockets.connect(f"ws://127.0.0.1:{port}") as ws:
        await ws.send(json.dumps({"type": "join", "room": "r1",
                                  "agent": "a1", "human": "sara"}))
        await _recv(ws, "policy")

        path.write_text("nonsense = = =")
        clock.advance(2.0)

        await ws.send(json.dumps({"type": "claim", "region": REGION,
                                  "intent": "refactor"}))
        result = await _recv(ws, "claim_result")
        assert result["granted"] is True
        assert relay._policy.current().degraded
        assert relay._policy.current().floor_table("")[3] == "notify"


# --------------------------------------------------------------------------
# the file format the C++ daemon reads
#
# The compiled cache is the whole interface between the two halves. Python
# writes it, `cpp/daemon/policy_cache.cpp` reads it, and nothing type-checks
# across that boundary — so it is checked here instead.
# --------------------------------------------------------------------------


def test_the_compiled_cache_is_one_line_of_five_and_five(tmp_path):
    dest = tmp_path / "policy.json"
    write_runtime_cache(dest, compile_runtime(discover(None, env={"HOME": str(tmp_path)})))
    raw = dest.read_text()

    assert raw.count("\n") == 1, "the daemon reads this as one line"
    blob = json.loads(raw)
    for key in ("table", "floor"):
        assert isinstance(blob[key], list) and len(blob[key]) == 5
        assert all(name in EFFECTS for name in blob[key])
    assert blob["schema"] == 1


def test_the_compiled_cache_never_writes_a_name_the_daemon_cannot_read():
    """`parse_effect` in policy_cache.cpp knows exactly five words. If Python
    ever grows a sixth, the daemon holds that rung at its previous value — which
    is safe, and silently wrong. Better to notice here."""
    names = _cpp_effect_names()
    assert names == list(EFFECTS), f"C++ knows {names}, Python writes {list(EFFECTS)}"


def test_the_two_builtin_tables_agree_across_the_language_boundary():
    """`kBuiltin` in C++ and `BUILTIN` in Python are the same claim written
    twice: installing this and configuring nothing is today's behaviour. Drift
    between them is exactly how that stops being true, silently."""
    assert _cpp_table("kBuiltin") == list(BUILTIN.names())
    assert _cpp_table("kBuiltinFloor") == list(BUILTIN_FLOOR.names())


def _cpp_header() -> str:
    header = CPP / "daemon" / "policy_cache.hpp"
    if not header.exists():  # pragma: no cover - only in a python-only checkout
        pytest.skip("no C++ tree here")
    return header.read_text()


def _cpp_effect_names() -> list[str]:
    # In hook/protocol.hpp and not policy_cache.cpp: the names go over the wire
    # now that the hook reads `"effect"`, so they live with the rest of the
    # protocol both halves have to spell the same way.
    body = re.search(r"kEffectNames\[kEffects\]\s*=\s*\{([^}]*)\}",
                     (CPP / "hook" / "protocol.hpp").read_text())
    assert body is not None, "kEffectNames moved; this test is the reason it matters"
    return re.findall(r'"([a-z]+)"', body.group(1))


def _cpp_table(name: str) -> list[str]:
    """The five Effect:: enumerators of a constexpr PolicyTable, lowercased."""
    text = _cpp_header()
    body = re.search(rf"{name}\{{\s*\{{(.*?)\}}\}};", text, re.S)
    assert body is not None, f"{name} moved in policy_cache.hpp"
    return [m.lower() for m in re.findall(r"Effect::(\w+)", body.group(1))]


def test_both_halves_agree_on_where_the_compiled_cache_lives():
    """Python writes it and `daemon/main.cpp` reads it, and the only thing
    joining them is the filename. Rename it on one side and the daemon runs on
    the builtin table forever, correctly and silently, which is the worst way
    for this to break."""
    main = (CPP / "daemon" / "main.cpp").read_text()
    assert RUNTIME_CACHE_NAME in main, (
        f"daemon/main.cpp does not mention {RUNTIME_CACHE_NAME!r}"
    )
    assert runtime_cache_path({"XDG_RUNTIME_DIR": "/run/u"}).name == RUNTIME_CACHE_NAME


def test_a_degraded_policy_still_compiles_to_something_the_daemon_can_use(tmp_path):
    """The cache is written by `ap policy compile`, which runs against whatever
    is on disk — including a file somebody just broke. The blob it writes still
    has to be readable, and still has to be at or above the floor."""
    broken = build_policy([builtin_layer(),
                           parse_layer("= = =", name="repo", source="broken.toml")])
    blob = compile_runtime(broken)
    assert blob["degraded"] is True
    assert blob["problem"]
    assert all(name in EFFECTS for name in blob["table"])
    for rung in range(5):
        assert EFFECTS.index(blob["table"][rung]) >= EFFECTS.index(BUILTIN_FLOOR[rung])
