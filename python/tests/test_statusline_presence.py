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
CPP = ROOT / "cpp"
WRITER_SRC = pathlib.Path(__file__).resolve().parent / "helpers" / "snapshot_writer.cpp"

# Either nothing at all, or one whole segment. Nothing in between.
SEGMENT = re.compile(r"^· (?:[0-9]+ agents here|.+ here)\Z")


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
        e["AGENT_PRESENCE_SNAPSHOT"] = str(snapshot)
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


def snap(tmp_path, body, name="agent-presence.json"):
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
    p = tmp_path / "agent-presence.json"
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
    d = tmp_path / "agent-presence.json"
    d.mkdir()
    ok(run(d))


def test_snapshot_path_is_a_fifo(tmp_path):
    # A fifo nobody is writing to blocks a naive read forever, and the prompt
    # with it.
    p = tmp_path / "agent-presence.json"
    os.mkfifo(p)
    try:
        r = run(p, timeout=5)
    except subprocess.TimeoutExpired:
        pytest.fail("statusline hung on a fifo")
    ok(r)


def test_snapshot_is_a_dangling_symlink(tmp_path):
    p = tmp_path / "agent-presence.json"
    p.symlink_to(tmp_path / "gone.json")
    ok(run(p))


def test_huge_file_finishes_fast(tmp_path):
    p = tmp_path / "agent-presence.json"
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
    (tmp_path / "agent-presence.json").write_text(peers_json("sara"))
    r = ok(run(None, env={"XDG_RUNTIME_DIR": str(tmp_path)}))
    assert r.out == "· sara here"


def test_default_path_falls_back_to_tmpdir(tmp_path):
    # cpp/daemon/main.cpp: XDG_RUNTIME_DIR, else TMPDIR, else /tmp. On macOS
    # only TMPDIR is set, so skipping it points the reader at a file the daemon
    # never writes.
    (tmp_path / "agent-presence.json").write_text(peers_json("sara"))
    r = ok(run(None, env={"TMPDIR": str(tmp_path)}))
    assert r.out == "· sara here"


def test_xdg_runtime_dir_wins_over_tmpdir(tmp_path):
    xdg = tmp_path / "xdg"
    tmp = tmp_path / "tmp"
    xdg.mkdir()
    tmp.mkdir()
    (xdg / "agent-presence.json").write_text(peers_json("sara"))
    (tmp / "agent-presence.json").write_text(peers_json("a", "b", "c"))
    r = ok(run(None, env={"XDG_RUNTIME_DIR": str(xdg), "TMPDIR": str(tmp)}))
    assert r.out == "· sara here"


def test_trailing_slash_on_tmpdir(tmp_path):
    # macOS hands out TMPDIR with a trailing slash.
    (tmp_path / "agent-presence.json").write_text(peers_json("sara"))
    r = ok(run(None, env={"TMPDIR": str(tmp_path) + "/"}))
    assert r.out == "· sara here"


# --- end to end against the daemon's real writer ------------------------------


@pytest.fixture(scope="module")
def writer(tmp_path_factory):
    """Compile a shim around the daemon's write_snapshot."""
    cxx = os.environ.get("CXX") or shutil.which("c++") or shutil.which("g++")
    if not cxx:
        pytest.skip("no C++ compiler")
    out = tmp_path_factory.mktemp("writer") / "snapshot_writer"
    proc = subprocess.run(
        [cxx, "-std=c++20", "-I", str(CPP), str(WRITER_SRC),
         str(CPP / "daemon" / "snapshot.cpp"), "-o", str(out)],
        capture_output=True, text=True,
    )
    assert proc.returncode == 0, f"shim did not build:\n{proc.stderr}"
    return out


def write_real_snapshot(writer, path, peers):
    args = [str(writer), str(path)]
    for human, verb, p in peers:
        args += [human, verb, p]
    subprocess.run(args, check=True, timeout=30)


def test_e2e_daemon_writer_no_peers(writer, tmp_path):
    p = tmp_path / "agent-presence.json"
    write_real_snapshot(writer, p, [])
    r = ok(run(p))
    assert r.out == ""


def test_e2e_daemon_writer_one_peer(writer, tmp_path):
    p = tmp_path / "agent-presence.json"
    write_real_snapshot(writer, p, [("sara", "edit", "src/auth.py")])
    r = ok(run(p))
    assert r.out == "· sara here"


def test_e2e_daemon_writer_three_peers(writer, tmp_path):
    p = tmp_path / "agent-presence.json"
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
    p = tmp_path / "agent-presence.json"
    write_real_snapshot(writer, p, [(human, "edit", "src/a.py")])
    r = ok(run(p))
    assert r.out == f"· {human} here"


def test_e2e_odd_path_does_not_inflate_the_count(writer, tmp_path):
    p = tmp_path / "agent-presence.json"
    write_real_snapshot(writer, p, [("sara", "edit", '/tmp/"human":"ghost"')])
    r = ok(run(p))
    assert r.out == "· sara here"


def test_e2e_odd_names_with_several_peers(writer, tmp_path):
    p = tmp_path / "agent-presence.json"
    write_real_snapshot(writer, p, [
        ('sa"ra', "edit", "a.py"),
        ("back\\slash", "read", 'b".py'),
    ])
    r = ok(run(p))
    assert r.out == "· 2 agents here"
