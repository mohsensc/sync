"""The statusline segment.

This runs in the user's prompt once a second, so the bar is low and absolute:
never a non-zero exit, never a half-written line, never a wait. Everything here
drives scripts/statusline-presence.sh as a subprocess, the way the prompt does.
"""

import os
import pathlib
import re
import shutil
import stat
import subprocess
import time

import pytest

ROOT = pathlib.Path(__file__).resolve().parents[2]
SCRIPT = ROOT / "scripts" / "statusline-presence.sh"
GO_ROOT = ROOT / "go"

# Either nothing at all, or one whole segment. Nothing in between.
# The trailing `!` is the policy-degraded marker; `· policy degraded` is what
# that marker becomes when there are no peers to hang it off.
SEGMENT = re.compile(r"^· (?:policy degraded|(?:[0-9]+ agents here|.+ here)!?)\Z")


class Result:
    def __init__(self, proc):
        self.code = proc.returncode
        self.out = proc.stdout.decode("utf-8", "replace")
        self.err = proc.stderr.decode("utf-8", "replace")

    def __repr__(self):
        return f"Result(code={self.code}, out={self.out!r}, err={self.err!r})"


def run(snapshot=None, env=None, timeout=10):
    """Run the segment the way a prompt does: clean env, hard timeout."""
    e = {"PATH": os.environ.get("PATH", "/usr/bin:/bin")}
    if snapshot is not None:
        e["AGENT_SYNC_SNAPSHOT"] = str(snapshot)
    e.update(env or {})
    proc = subprocess.run(
        [str(SCRIPT)], capture_output=True, env=e, timeout=timeout
    )
    return Result(proc)


def ok(r):
    """Every run has to clear these, whatever the input was."""
    assert r.code == 0, f"non-zero exit: {r}"
    assert r.err == "", f"noise on stderr: {r}"
    assert "\n" not in r.out, f"multi-line output: {r}"
    assert "\r" not in r.out, f"carriage return in output: {r}"
    if r.out:
        assert SEGMENT.match(r.out), f"not a whole segment: {r}"
    return r


def snap(tmp_path, body, name="agent-sync.json"):
    p = tmp_path / name
    p.write_text(body, encoding="utf-8")
    return p


def peers_json(*humans):
    body = ",".join(
        '{"human":"%s","verb":"edit","path":"src/a.py"}' % h for h in humans
    )
    return '{"peers":[' + body + "]}"


# --- the six cases the segment has to survive ---------------------------------


def test_no_snapshot_file(tmp_path):
    r = ok(run(tmp_path / "does-not-exist.json"))
    assert r.out == ""


@pytest.mark.skipif(os.geteuid() == 0, reason="root can read anything")
def test_unreadable_snapshot(tmp_path):
    p = snap(tmp_path, peers_json("sara"))
    p.chmod(0)
    try:
        r = ok(run(p))
        assert r.out == ""
    finally:
        p.chmod(stat.S_IRUSR | stat.S_IWUSR)


def test_empty_peer_list(tmp_path):
    # The daemon writes exactly this on startup. It has to read as "nobody
    # here", not as an error and not as a stray bullet.
    r = ok(run(snap(tmp_path, '{"peers":[]}')))
    assert r.out == ""


def test_exactly_one_peer(tmp_path):
    r = ok(run(snap(tmp_path, peers_json("sara"))))
    assert r.out == "· sara here"


def test_several_peers(tmp_path):
    r = ok(run(snap(tmp_path, peers_json("sara", "dev", "kim"))))
    assert r.out == "· 3 agents here"


def test_two_peers_still_reads_as_a_count(tmp_path):
    r = ok(run(snap(tmp_path, peers_json("sara", "dev"))))
    assert r.out == "· 2 agents here"


def test_quotes_in_a_name_survive_intact(tmp_path):
    # The writer escapes " as \" — the reader has to undo that, not choke on it
    # and print half a name.
    body = '{"peers":[{"human":"sa\\"ra","verb":"edit","path":"a.py"}]}'
    r = ok(run(snap(tmp_path, body)))
    assert r.out == '· sa"ra here'


def test_backslash_in_a_name_survives_intact(tmp_path):
    body = '{"peers":[{"human":"back\\\\slash","verb":"edit","path":"a.py"}]}'
    r = ok(run(snap(tmp_path, body)))
    assert r.out == "· back\\slash here"


def test_a_value_that_looks_like_a_field_does_not_inflate_the_count(tmp_path):
    # One peer whose path contains an escaped "human":"..." . Counting raw
    # occurrences of the key would report two people in the room.
    body = (
        '{"peers":[{"human":"sara","verb":"edit",'
        '"path":"/tmp/\\"human\\":\\"ghost\\""}]}'
    )
    r = ok(run(snap(tmp_path, body)))
    assert r.out == "· sara here"


def test_unicode_name(tmp_path):
    r = ok(run(snap(tmp_path, peers_json("sara ✅ 東京"))))
    assert r.out == "· sara ✅ 東京 here"


def test_shell_metacharacters_in_a_name_are_not_expanded(tmp_path):
    r = ok(run(snap(tmp_path, peers_json("$(touch /tmp/pwned) * `id`"))))
    assert r.out == "· $(touch /tmp/pwned) * `id` here"
    assert not pathlib.Path("/tmp/pwned").exists()


# --- malformed input ----------------------------------------------------------


def test_garbage_content(tmp_path):
    ok(run(snap(tmp_path, "this is not json at all")))


def test_binary_content(tmp_path):
    p = tmp_path / "agent-sync.json"
    p.write_bytes(bytes(range(256)) * 8)
    ok(run(p))


def test_truncated_mid_name(tmp_path):
    # Should not happen (the writer renames into place) but a torn file must
    # not turn into a torn prompt.
    ok(run(snap(tmp_path, '{"peers":[{"human":"sa')))


def test_empty_file(tmp_path):
    r = ok(run(snap(tmp_path, "")))
    assert r.out == ""


def test_peer_with_an_empty_name_still_counts(tmp_path):
    r = ok(run(snap(tmp_path, peers_json(""))))
    assert r.out == "· 1 agent here"


def test_absurdly_long_name_does_not_take_over_the_prompt(tmp_path):
    r = ok(run(snap(tmp_path, peers_json("x" * 5000))))
    assert len(r.out) < 80


def test_newline_inside_the_file(tmp_path):
    r = ok(run(snap(tmp_path, peers_json("sara") + "\n")))
    assert r.out == "· sara here"


def test_many_peers(tmp_path):
    r = ok(run(snap(tmp_path, peers_json(*[f"a{i}" for i in range(200)]))))
    assert r.out == "· 200 agents here"


# --- things that would wedge a prompt -----------------------------------------


def test_snapshot_path_is_a_directory(tmp_path):
    d = tmp_path / "agent-sync.json"
    d.mkdir()
    ok(run(d))


def test_snapshot_path_is_a_fifo(tmp_path):
    # A fifo nobody is writing to blocks a naive read forever, and the prompt
    # with it.
    p = tmp_path / "agent-sync.json"
    os.mkfifo(p)
    try:
        r = run(p, timeout=5)
    except subprocess.TimeoutExpired:
        pytest.fail("statusline hung on a fifo")
    ok(r)


def test_snapshot_is_a_dangling_symlink(tmp_path):
    p = tmp_path / "agent-sync.json"
    p.symlink_to(tmp_path / "gone.json")
    ok(run(p))


def test_huge_file_finishes_fast(tmp_path):
    p = tmp_path / "agent-sync.json"
    p.write_text('{"peers":[' + ("x" * 4_000_000) + "]}", encoding="utf-8")
    start = time.monotonic()
    r = ok(run(p, timeout=10))
    assert time.monotonic() - start < 2.0


def test_a_normal_tick_is_quick(tmp_path):
    p = snap(tmp_path, peers_json("sara", "dev"))
    start = time.monotonic()
    for _ in range(5):
        ok(run(p))
    per_tick = (time.monotonic() - start) / 5
    assert per_tick < 0.5, f"{per_tick:.3f}s per tick is too slow for a prompt"


# --- default path: the script and the daemon must land on the same file --------


def test_default_path_follows_xdg_runtime_dir(tmp_path):
    (tmp_path / "agent-sync.json").write_text(peers_json("sara"))
    r = ok(run(None, env={"XDG_RUNTIME_DIR": str(tmp_path)}))
    assert r.out == "· sara here"


def test_default_path_falls_back_to_tmpdir(tmp_path):
    # cpp/daemon/main.cpp: XDG_RUNTIME_DIR, else TMPDIR, else /tmp. On macOS
    # only TMPDIR is set, so skipping it points the reader at a file the daemon
    # never writes.
    (tmp_path / "agent-sync.json").write_text(peers_json("sara"))
    r = ok(run(None, env={"TMPDIR": str(tmp_path)}))
    assert r.out == "· sara here"


def test_xdg_runtime_dir_wins_over_tmpdir(tmp_path):
    xdg = tmp_path / "xdg"
    tmp = tmp_path / "tmp"
    xdg.mkdir()
    tmp.mkdir()
    (xdg / "agent-sync.json").write_text(peers_json("sara"))
    (tmp / "agent-sync.json").write_text(peers_json("a", "b", "c"))
    r = ok(run(None, env={"XDG_RUNTIME_DIR": str(xdg), "TMPDIR": str(tmp)}))
    assert r.out == "· sara here"


def test_trailing_slash_on_tmpdir(tmp_path):
    # macOS hands out TMPDIR with a trailing slash.
    (tmp_path / "agent-sync.json").write_text(peers_json("sara"))
    r = ok(run(None, env={"TMPDIR": str(tmp_path) + "/"}))
    assert r.out == "· sara here"


# --- sock-derived path: #90, a second daemon on AGENT_SYNC_SOCK -----------
#
# go/cmd/presenced/main.go's siblingPath, ported here: the snapshot lives
# beside the socket, named after it. Before this the script only ever
# looked at the fixed name, so a second daemon on a repo's own socket had
# its segment silently reading the first repo's snapshot.


def test_sock_override_alone_redirects_the_reader(tmp_path):
    (tmp_path / "ap2.json").write_text(peers_json("sara"))
    r = ok(run(None, env={"AGENT_SYNC_SOCK": str(tmp_path / "ap2.sock")}))
    assert r.out == "· sara here"


def test_sock_override_does_not_read_the_default_name(tmp_path):
    # The fixed name still exists on disk, from a first daemon; the second
    # daemon's socket has to win, not fall through to it.
    (tmp_path / "agent-sync.json").write_text(peers_json("wrong-daemon"))
    (tmp_path / "ap2.json").write_text(peers_json("sara"))
    r = ok(run(None, env={"AGENT_SYNC_SOCK": str(tmp_path / "ap2.sock")}))
    assert r.out == "· sara here"


def test_explicit_snapshot_still_beats_socket_derivation(tmp_path):
    (tmp_path / "ap2.json").write_text(peers_json("wrong-daemon"))
    explicit = tmp_path / "wherever.json"
    explicit.write_text(peers_json("sara"))
    r = ok(run(None, env={
        "AGENT_SYNC_SOCK": str(tmp_path / "ap2.sock"),
        "AGENT_SYNC_SNAPSHOT": str(explicit),
    }))
    assert r.out == "· sara here"


def test_two_sockets_sharing_a_runtime_dir_read_two_snapshots(tmp_path):
    (tmp_path / "a.json").write_text(peers_json("carol"))
    (tmp_path / "b.json").write_text(peers_json("dan"))
    a = ok(run(None, env={"AGENT_SYNC_SOCK": str(tmp_path / "a.sock")}))
    b = ok(run(None, env={"AGENT_SYNC_SOCK": str(tmp_path / "b.sock")}))
    assert a.out == "· carol here"
    assert b.out == "· dan here"


# No-env-at-all coverage for the ordinary single-daemon case already lives
# above (test_default_path_follows_xdg_runtime_dir and friends) — this
# section only adds AGENT_SYNC_SOCK to the picture.


# --- end to end against the daemon's real writer ------------------------------


@pytest.fixture(scope="module")
def writer(tmp_path_factory):
    """Build the shim around the daemon's real WriteSnapshot (go/cmd/snapshot_writer)."""
    go = shutil.which("go")
    if not go:
        pytest.skip("no go toolchain")
    out = tmp_path_factory.mktemp("writer") / "snapshot_writer"
    proc = subprocess.run(
        [go, "build", "-o", str(out), "./cmd/snapshot_writer"],
        cwd=str(GO_ROOT), capture_output=True, text=True,
    )
    assert proc.returncode == 0, f"shim did not build:\n{proc.stderr}"
    return out


def write_real_snapshot(writer, path, peers):
    args = [str(writer), str(path)]
    for human, verb, p in peers:
        args += [human, verb, p]
    subprocess.run(args, check=True, timeout=30)


def test_e2e_daemon_writer_no_peers(writer, tmp_path):
    p = tmp_path / "agent-sync.json"
    write_real_snapshot(writer, p, [])
    r = ok(run(p))
    assert r.out == ""


def test_e2e_daemon_writer_one_peer(writer, tmp_path):
    p = tmp_path / "agent-sync.json"
    write_real_snapshot(writer, p, [("sara", "edit", "src/auth.py")])
    r = ok(run(p))
    assert r.out == "· sara here"


def test_e2e_daemon_writer_three_peers(writer, tmp_path):
    p = tmp_path / "agent-sync.json"
    write_real_snapshot(writer, p, [
        ("sara", "edit", "src/auth.py"),
        ("dev", "read", "src/db.py"),
        ("kim", "edit", "web/app.tsx"),
    ])
    r = ok(run(p))
    assert r.out == "· 3 agents here"


@pytest.mark.parametrize("human", [
    'sa"ra',
    "back\\slash",
    'quote"and\\both',
    '","human":"ghost',
    "sara ✅",
    "name with spaces",
    "· bullet",
    "$(id) `id` *",
])
def test_e2e_odd_names_round_trip(writer, tmp_path, human):
    """Whatever the writer escapes, the reader has to unescape the same way."""
    p = tmp_path / "agent-sync.json"
    write_real_snapshot(writer, p, [(human, "edit", "src/a.py")])
    r = ok(run(p))
    assert r.out == f"· {human} here"


def test_e2e_odd_path_does_not_inflate_the_count(writer, tmp_path):
    p = tmp_path / "agent-sync.json"
    write_real_snapshot(writer, p, [("sara", "edit", '/tmp/"human":"ghost"')])
    r = ok(run(p))
    assert r.out == "· sara here"


def test_e2e_odd_names_with_several_peers(writer, tmp_path):
    p = tmp_path / "agent-sync.json"
    write_real_snapshot(writer, p, [
        ('sa"ra', "edit", "a.py"),
        ("back\\slash", "read", 'b".py'),
    ])
    r = ok(run(p))
    assert r.out == "· 2 agents here"


def test_e2e_newline_in_a_name_keeps_the_file_one_line(writer, tmp_path):
    # The bug #19's rewrite of WriteSnapshot fixes: the old hand-rolled
    # escaper touched only " and \, so a raw newline in a name broke the
    # snapshot out of its one-line contract instead of being escaped into
    # it. encoding/json escapes every control byte, so the file this script
    # reads with `read -r -n 65536` (one line, full stop) stays one line no
    # matter what a peer's name contains.
    p = tmp_path / "agent-sync.json"
    write_real_snapshot(writer, p, [("before\nafter", "edit", "src/a.py")])
    raw = p.read_text(encoding="utf-8")
    assert "\n" not in raw, f"a peer name broke the one-line contract: {raw!r}"

    r = ok(run(p))
    # bash unescapes \" and \\ only, so \n passes through as two literal
    # characters rather than an actual line break landing in someone's
    # prompt — which is the point.
    assert r.out == "· before\\nafter here"


# --- the degraded marker ------------------------------------------------------
#
# go/internal/presence's WriteSnapshot puts these two keys at the top level
# whenever the daemon's PolicyCache has a problem — a bad effect name the
# compiler kept going past, a cache that could not be read, one that
# vanished. docs/policy-design.md §9 says degradation is loud, and names this
# script as one of the three places it has to show up. It showed up in none
# of them: the flag was written and nothing read it.


def degraded_json(*humans, problem="policy.toml:3: rung3 = 'loud' is not an effect"):
    body = ",".join(
        '{"human":"%s","verb":"edit","path":"src/a.py"}' % h for h in humans
    )
    return (
        '{"peers":[' + body + '],"policy_degraded":true,'
        '"policy_problem":"' + problem + '"}'
    )


def test_degraded_with_no_peers_says_so(tmp_path):
    # The case the flag exists for. One machine, nobody else about, and a
    # policy that is not the one the person thinks they configured.
    r = ok(run(snap(tmp_path, degraded_json())))
    assert r.out == "· policy degraded"


def test_degraded_marks_a_single_peer_segment(tmp_path):
    r = ok(run(snap(tmp_path, degraded_json("sara"))))
    assert r.out == "· sara here!"


def test_degraded_marks_a_count_segment(tmp_path):
    r = ok(run(snap(tmp_path, degraded_json("sara", "dev", "kim"))))
    assert r.out == "· 3 agents here!"


def test_a_healthy_snapshot_is_unmarked(tmp_path):
    # The flag is absent on every healthy write, so this is also the guard
    # against the marker leaking into the normal segment.
    assert ok(run(snap(tmp_path, peers_json("sara")))).out == "· sara here"
    assert ok(run(snap(tmp_path, '{"peers":[]}'))).out == ""
    # ...and false is not true.
    body = '{"peers":[],"policy_degraded":false}'
    assert ok(run(snap(tmp_path, body))).out == ""


def test_a_peer_name_cannot_forge_the_marker(tmp_path):
    # The name arrives over a socket and lands in this string. snapshot.cpp
    # escapes every quote in it, so there is no way to close the string and
    # write a top-level key — this is the test that says so.
    forged = '{"peers":[{"human":"a\\",\\"policy_degraded\\":true,\\"x\\":\\"b",'
    forged += '"verb":"edit","path":"src/a.py"}]}'
    r = ok(run(snap(tmp_path, forged)))
    assert not r.out.endswith("!")
