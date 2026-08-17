"""The compiled policy cache: the file format the Go daemon reads.

Was test_policy_live_reload.py — that file's other half drove a live
Python `Relay` object in-process to prove editing a policy file changes
what a *running* relay does. The relay it drove is gone (#40); the
equivalent property is now pinned on the Go side —
`go/internal/relaysrv/policy_test.go`'s `TestEditingTheOrgFileTakesEffect...`
family for `PolicyFile` itself, and `relay_policy_test.go`'s
`TestTheOrgFloorIsPushedOnJoin...` / `TestEditingTheOrgFileRepublishes...`
for the relay wiring on top of it.

What's here has no relay dependency at all: `policy.py`'s `compile_runtime`
writes a blob `go/internal/policy` reads on a tick it already runs, and this
is the contract between the two, checked from the Python side the same way
it always was.
"""

from __future__ import annotations

import json
import re
from pathlib import Path

from agent_presence.policy import (
    BUILTIN,
    BUILTIN_FLOOR,
    EFFECTS,
    RUNTIME_CACHE_NAME,
    build_policy,
    builtin_layer,
    compile_runtime,
    discover,
    parse_layer,
    runtime_cache_path,
    write_runtime_cache,
)

CPP = Path(__file__).resolve().parents[2] / "cpp"
GO = Path(__file__).resolve().parents[2] / "go"


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
    """`parse_effect` in policy_cache.cpp (the hook's own copy, see
    cpp/hook/protocol.hpp) knows exactly five words. If Python ever grows a
    sixth, a reader holds that rung at its previous value — which is safe,
    and silently wrong. Better to notice here."""
    names = _cpp_effect_names()
    assert names == list(EFFECTS), f"C++ knows {names}, Python writes {list(EFFECTS)}"


def test_the_two_builtin_tables_agree_across_the_language_boundary():
    """`Builtin` in Go and `BUILTIN` in Python are the same claim written
    twice: installing this and configuring nothing is today's behaviour. Drift
    between them is exactly how that stops being true, silently."""
    assert _go_table("Builtin") == list(BUILTIN.names())
    assert _go_table("BuiltinFloor") == list(BUILTIN_FLOOR.names())


def _cpp_effect_names() -> list[str]:
    # Still cpp/hook/protocol.hpp: the hook stays C++ (see
    # docs/gohook-spike.md) and this is the one place the five effect names
    # are spelled on that side.
    body = re.search(r"kEffectNames\[kEffects\]\s*=\s*\{([^}]*)\}",
                     (CPP / "hook" / "protocol.hpp").read_text())
    assert body is not None, "kEffectNames moved; this test is the reason it matters"
    return re.findall(r'"([a-z]+)"', body.group(1))


def _go_policy_source() -> str:
    src = GO / "internal" / "policy" / "policy.go"
    return src.read_text()


def _go_table(name: str) -> list[str]:
    """The five Effect identifiers of a `var Name = Table{...}`, lowercased."""
    text = _go_policy_source()
    body = re.search(rf"{name}\s*=\s*Table\{{(.*?)\}}", text, re.S)
    assert body is not None, f"{name} moved in go/internal/policy/policy.go"
    return [m.lower() for m in re.findall(r"\b(Silent|Notify|Context|Ask|Deny)\b", body.group(1))]


def test_both_halves_agree_on_where_the_compiled_cache_lives():
    """Python writes it and `go/cmd/presenced` reads it, and the only thing
    joining them is the filename. Rename it on one side and the daemon runs on
    the builtin table forever, correctly and silently, which is the worst way
    for this to break.

    presenced no longer spells the whole name in one literal: it derives every
    sibling file from its socket, so two daemons sharing a runtime dir stop
    sharing one journal. The name it lands on is unchanged, and this rebuilds
    it from the two literals main.go actually carries — which is what has to
    keep matching."""
    main = (GO / "cmd" / "presenced" / "main.go").read_text()

    sock = re.search(r'"AGENT_PRESENCE_SOCK",\s*runtime\+"/([^"]+)"', main)
    assert sock is not None, "cmd/presenced/main.go's default socket name moved"
    suffix = re.search(r'siblingPath\(sock, "(policy\.[^"]+)"\)', main)
    assert suffix is not None, "cmd/presenced/main.go stopped deriving the policy cache path"

    stem = sock.group(1).rsplit(".", 1)[0]
    derived = f"{stem}.{suffix.group(1)}"
    assert derived == RUNTIME_CACHE_NAME, (
        f"presenced defaults its policy cache to {derived!r}, "
        f"python writes {RUNTIME_CACHE_NAME!r}"
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
