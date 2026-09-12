"""Two teammates, two checkouts of one repo, one file.

This is the product's whole premise and nothing tested it. Every other suite
in this repo drives one process, or several processes that happen to share a
filesystem — and under that assumption a region named by its absolute path
looks perfectly correct. It isn't: a room is a hash of the origin remote,
deliberately, so two clones land in one room, and the region key inside that
room then had to be relative to the repo or the room's whole purpose was
defeated. Verified against the real binaries before the fix: carol claiming
/Users/carol/work/repo/src/orders.py and dan claiming
/Users/dan/dev/repo/src/orders.py were both granted, same room, same file,
no collision.

Runs the real gorelay and two real presenced processes over real sockets.

Most "not blocked" assertions in this file follow a "somebody else IS
blocked" control on the same daemon first. Without it, "carol is not
blocked by her own claim" is satisfied just as well by a daemon that never
received carol's lease at all — the same daemon that would also, wrongly,
say a stranger isn't blocked either. The control rules that out before the
negative check is trusted.

One honest gap: _claim() below sends an already-relative region key over
the wire, the way a client that has already run repo.RegionKey locally
would. It never drives the MCP surface's own RegionKey normalization —
that surface lives outside this file's ownership.
"""

from __future__ import annotations

import asyncio
import json
import os
import pathlib
import shutil
import socket
import subprocess
import sys
import tempfile
import time

import pytest
import websockets

from agent_sync import journal as journal_mod
from agent_sync import paths as paths_mod

sys.path.insert(0, str(pathlib.Path(__file__).parent / "helpers"))
from gorelay_proc import start_gorelay  # noqa: E402
from presenced_proc import find_or_build_presenced, start_presenced  # noqa: E402

STATUSLINE = pathlib.Path(__file__).resolve().parents[2] / "scripts" / "statusline-presence.sh"

ROOM = "two-checkouts"
FILE = "src/orders.py"
# A brand new file under two directory levels neither checkout has created
# yet — resolveExisting's reason to walk more than one parent up, not just
# repo.RegionKey's reason to exist.
NEWFILE = "pkg/mod/new_thing.py"

# A third identity, neither claimant nor rival-in-the-scenario, used purely
# as a control: if *this* agent isn't blocked on a path somebody else holds,
# nothing about "the holder isn't blocked by their own lease" means anything.
STRANGER_AGENT = "sess-mallory"
STRANGER_HUMAN = "mallory"


def _git(*args, cwd=None):
    env = {"GIT_AUTHOR_NAME": "t", "GIT_AUTHOR_EMAIL": "t@e.com",
           "GIT_COMMITTER_NAME": "t", "GIT_COMMITTER_EMAIL": "t@e.com",
           "PATH": "/usr/bin:/bin:/usr/local/bin:/opt/homebrew/bin"}
    return subprocess.run(["git", *args], cwd=cwd, env=env,
                          capture_output=True, text=True, check=True)


@pytest.fixture
def sockdir():
    """Somewhere short enough to bind.

    pytest's tmp_path on macOS is a ~110-byte /var/folders path before a
    filename is even appended, and AF_UNIX caps a path near 104 bytes. The
    checkouts can live wherever; the sockets cannot.
    """
    d = tempfile.mkdtemp(prefix="ap-", dir="/tmp")
    try:
        yield pathlib.Path(d)
    finally:
        shutil.rmtree(d, ignore_errors=True)


def _seed_origin(tmp_path: pathlib.Path) -> pathlib.Path:
    """One bare origin with FILE committed and pushed — the common
    ancestor every fixture below clones from.

    --initial-branch, or the bare repo's HEAD names a branch nothing pushes
    to, git clone checks out nothing, and every "checkout" below is an
    empty directory that quietly makes this whole file a no-op.
    """
    origin = tmp_path / "origin.git"
    _git("init", "-q", "--bare", "--initial-branch=main", str(origin))

    seed = tmp_path / "seed"
    _git("init", "-q", "-b", "main", str(seed))
    (seed / "src").mkdir(parents=True)
    (seed / FILE).write_text("class Order:\n    def total(self):\n        return 0\n")
    _git("add", "-A", cwd=seed)
    _git("commit", "-qm", "seed", cwd=seed)
    _git("remote", "add", "origin", str(origin), cwd=seed)
    _git("push", "-q", "origin", "main", cwd=seed)
    return origin


@pytest.fixture
def two_checkouts(tmp_path):
    """One bare origin, two clones — the same remote, so the same room."""
    origin = _seed_origin(tmp_path)
    out = []
    for who in ("carol", "dan"):
        clone = tmp_path / who
        _git("clone", "-q", str(origin), str(clone))
        assert (clone / FILE).exists(), f"{who}'s checkout came out empty"
        out.append(clone)
    return out


@pytest.fixture
def two_checkouts_one_symlinked(tmp_path):
    """Same premise, but carol reaches her clone through a symlink and dan
    does not — the exact split repo.RegionKeyResolved's retry exists for.

    A daemon finds its repo root from os.Getwd(), which resolves symlinks
    away whenever $PWD isn't already set to the same directory — the normal
    case for a daemon started by a script rather than typed into a login
    shell. A hook firing on a file carol opened through the symlink sends
    whatever absolute path the tool call carried, which keeps the symlink.
    Root ends up resolved, the incoming path doesn't, and the two have to
    still agree on one region. (On macOS /tmp is itself a symlink to
    /private/tmp, so this split is not a corner case there — it is the
    default for any checkout that lives under /tmp, which is why sockdir
    above has to.)
    """
    origin = _seed_origin(tmp_path)
    real = tmp_path / "carol-real"
    _git("clone", "-q", str(origin), str(real))
    link = tmp_path / "carol"
    link.symlink_to(real)
    dan = tmp_path / "dan"
    _git("clone", "-q", str(origin), str(dan))
    for who, checkout in (("carol", link), ("dan", dan)):
        assert (checkout / FILE).exists(), f"{who}'s checkout came out empty"
    return link, dan


async def _claim(url: str, agent: str, human: str, path: str) -> dict:
    """Take a lease the way the MCP surface does, and hold the connection —
    a lease dies with the connection that took it."""
    ws = await websockets.connect(url)
    await ws.send(json.dumps({"type": "join", "room": ROOM,
                              "agent": agent, "human": human}))
    await ws.send(json.dumps({"type": "claim", "region": {"path": path},
                              "intent": "refactor Order.total"}))
    async with asyncio.timeout(5):
        while True:
            msg = json.loads(await ws.recv())
            if msg.get("type") == "claim_result":
                return {"ws": ws, "granted": bool(msg.get("granted"))}


def _poll_blocked(daemon, *, path: str, agent: str, human: str,
                  verb: str = "edit", deadline: float = 5.0) -> dict:
    """Poll `.decide` until it reports a live conflict, instead of sleeping
    a fixed amount and checking once — a fixed sleep is a flake on a loaded
    machine, and this suite runs before every PR.

    Raises with the daemon's own recent stdout on timeout. A daemon that
    binds its sockets fine and then never actually joins the relay room
    (refused, wrong URL, connection reset) fails this exactly the way a
    genuinely-absent lease does — rung stays 0 forever — and nothing about
    the decide() reply itself says which one happened.
    """
    end = time.monotonic() + deadline
    last: dict = {}
    while time.monotonic() < end:
        last = daemon.decide(verb=verb, path=path, agent=agent, human=human)
        if last.get("rung", 0) > 0:
            return last
        time.sleep(0.05)
    raise AssertionError(
        f"never saw a conflict on {path!r} within {deadline}s for agent "
        f"{agent!r}; last decide reply was {last}\n"
        f"--- presenced's own recent output ---\n{daemon.recent_output()}"
    )


async def test_two_checkouts_of_one_repo_collide_on_one_file(two_checkouts, tmp_path, sockdir):
    carol, dan = two_checkouts
    relay = await start_gorelay()
    binary = find_or_build_presenced(tmp_path / "bin")
    daemons = []
    claim = None
    try:
        for who, checkout in (("carol", carol), ("dan", dan)):
            daemons.append(start_presenced(
                binary, cwd=str(checkout), relay_url=relay.url, room=ROOM,
                sock=str(sockdir / f"{who}.sock")))
        dcarol, ddan = daemons

        # Carol claims the file by its shared name. Her own daemon and dan's
        # both have to recognise that name from their own absolute paths.
        claim = await _claim(relay.url, "sess-carol", "carol", FILE)
        assert claim["granted"], "carol's claim was refused"

        # Dan, in a different directory on a different machine's worth of
        # path, editing the same file in the same repo.
        blocked = _poll_blocked(ddan, path=str(dan / FILE),
                                agent="sess-dan", human="dan")
        assert blocked.get("rung") == 3, (
            f"dan was not blocked by carol's lease: {blocked}"
        )
        assert blocked.get("holder") == "sess-carol"

        # A stranger's-lease control, on the exact path the "mine" check
        # below reuses: "carol is not blocked" is satisfied just as well by
        # a daemon that never received her lease at all, which would also
        # (wrongly) clear a stranger on the same path. Rule that out first.
        carol_path = str(carol / FILE)
        stranger_blocked = _poll_blocked(dcarol, path=carol_path,
                                agent=STRANGER_AGENT, human=STRANGER_HUMAN)
        assert stranger_blocked.get("rung") == 3, (
            f"a stranger was not blocked by carol's own lease, from carol's "
            f"own daemon: {stranger_blocked}"
        )
        assert stranger_blocked.get("holder") == "sess-carol"

        # And carol is not blocked by her own claim, which is a different
        # question than "no lease was found" — the stranger check above
        # proved this daemon, on this exact path, can see the lease at all.
        mine = dcarol.decide(verb="edit", path=carol_path,
                             agent="sess-carol", human="carol")
        assert mine.get("rung") == 0, (
            f"carol was blocked by her own claim: {mine}"
        )
    finally:
        if claim:
            await claim["ws"].close()
        for d in daemons:
            d.stop()
        await relay.stop()


async def test_a_file_outside_the_checkout_is_nobodys_business(two_checkouts, tmp_path, sockdir):
    """The other half of the rule. A path with no place in the repo has no
    shared name, so it keeps its absolute one and cannot collide with a
    teammate's unrelated file of the same name."""
    carol, dan = two_checkouts
    relay = await start_gorelay()
    binary = find_or_build_presenced(tmp_path / "bin")
    daemons = []
    claim = None
    try:
        for who, checkout in (("carol", carol), ("dan", dan)):
            daemons.append(start_presenced(
                binary, cwd=str(checkout), relay_url=relay.url, room=ROOM,
                sock=str(sockdir / f"{who}.sock")))
        _, ddan = daemons

        outside = tmp_path / "scratch" / "notes.md"
        outside.parent.mkdir(parents=True, exist_ok=True)
        outside.write_text("mine\n")
        claim = await _claim(relay.url, "sess-carol", "carol", str(outside))
        assert claim["granted"]

        # Positive control: the exact same absolute path, from dan, has to
        # collide. Without this, "dan's own scratch file doesn't collide"
        # below is equally explained by ddan never having heard of the
        # lease at all.
        same_path_blocked = _poll_blocked(ddan, path=str(outside),
                                agent="sess-dan", human="dan")
        assert same_path_blocked.get("rung") == 3, (
            f"dan was not blocked on carol's exact scratch path: {same_path_blocked}"
        )
        assert same_path_blocked.get("holder") == "sess-carol"

        # dan's own unrelated scratch file, same basename, different place.
        dan_outside = tmp_path / "dan-scratch" / "notes.md"
        dan_outside.parent.mkdir(parents=True, exist_ok=True)
        dan_outside.write_text("his\n")
        r = ddan.decide(verb="edit", path=str(dan_outside),
                        agent="sess-dan", human="dan")
        assert r.get("rung") == 0, f"two unrelated scratch files collided: {r}"
    finally:
        if claim:
            await claim["ws"].close()
        for d in daemons:
            d.stop()
        await relay.stop()


async def test_symlinked_checkout_still_collides(two_checkouts_one_symlinked, tmp_path, sockdir):
    """repo.RegionKeyResolved's whole reason to exist: carol's daemon's
    root comes back resolved (os.Getwd()'s default), a hook firing on a
    file she opened through her symlinked checkout sends the unresolved
    form, and the two have to land on one region key anyway. Covered only
    by unit tests before this — nothing end to end drove the mismatch."""
    link, dan = two_checkouts_one_symlinked
    relay = await start_gorelay()
    binary = find_or_build_presenced(tmp_path / "bin")
    daemons = []
    claim = None
    try:
        for who, checkout in (("carol", link), ("dan", dan)):
            daemons.append(start_presenced(
                binary, cwd=str(checkout), relay_url=relay.url, room=ROOM,
                sock=str(sockdir / f"sym-{who}.sock")))
        dcarol, ddan = daemons

        claim = await _claim(relay.url, "sess-carol", "carol", FILE)
        assert claim["granted"], "carol's claim was refused"

        # dan's side carries no symlink at all; he still has to see it.
        blocked = _poll_blocked(ddan, path=str(dan / FILE),
                                agent="sess-dan", human="dan")
        assert blocked.get("rung") == 3, (
            f"dan was not blocked by carol's lease, with carol's checkout "
            f"reached through a symlink: {blocked}"
        )
        assert blocked.get("holder") == "sess-carol"

        # carol's own daemon, asked about the exact symlinked path a hook
        # firing inside her checkout would carry, via a stranger so this
        # is a control and not the ambiguous "not blocked" question above.
        carol_path = str(link / FILE)
        stranger_blocked = _poll_blocked(dcarol, path=carol_path,
                                agent=STRANGER_AGENT, human=STRANGER_HUMAN)
        assert stranger_blocked.get("rung") == 3, (
            f"a stranger was not blocked by carol's lease, from carol's own "
            f"symlinked daemon: {stranger_blocked}"
        )
        assert stranger_blocked.get("holder") == "sess-carol"

        mine = dcarol.decide(verb="edit", path=carol_path,
                             agent="sess-carol", human="carol")
        assert mine.get("rung") == 0, (
            f"carol was blocked by her own claim through her own symlink: {mine}"
        )
    finally:
        if claim:
            await claim["ws"].close()
        for d in daemons:
            d.stop()
        await relay.stop()


async def test_new_file_in_new_directory_collides(two_checkouts_one_symlinked, tmp_path, sockdir):
    """The other thing that made the symlink fix inert in practice:
    resolveExisting has to walk up more than one directory level. An
    agent's Write tool creates pkg/mod/new_thing.py's every level at once,
    and until they exist on disk there is nothing for EvalSymlinks to
    resolve at all — a retry that only tried the immediate parent would
    fail here exactly the way no retry at all does. Carol's side is
    reached through the same symlink test_symlinked_checkout_still_collides
    uses, so this is that fix's harder case, not a different one."""
    link, dan = two_checkouts_one_symlinked
    relay = await start_gorelay()
    binary = find_or_build_presenced(tmp_path / "bin")
    daemons = []
    claim = None
    try:
        for who, checkout in (("carol", link), ("dan", dan)):
            daemons.append(start_presenced(
                binary, cwd=str(checkout), relay_url=relay.url, room=ROOM,
                sock=str(sockdir / f"new-{who}.sock")))
        dcarol, ddan = daemons

        # Neither checkout has this file, or its containing directories,
        # yet — that absence is the point.
        assert not (link / NEWFILE).exists()
        assert not (dan / NEWFILE).exists()

        claim = await _claim(relay.url, "sess-carol", "carol", NEWFILE)
        assert claim["granted"], "carol's claim was refused"

        blocked = _poll_blocked(ddan, path=str(dan / NEWFILE),
                                agent="sess-dan", human="dan")
        assert blocked.get("rung") == 3, (
            f"dan was not blocked on a new file in a new directory: {blocked}"
        )
        assert blocked.get("holder") == "sess-carol"

        # The load-bearing check: carol's own (symlinked) daemon, on the
        # not-yet-created file, via a stranger control as above.
        stranger_blocked = _poll_blocked(dcarol, path=str(link / NEWFILE),
                                agent=STRANGER_AGENT, human=STRANGER_HUMAN)
        assert stranger_blocked.get("rung") == 3, (
            f"a stranger was not blocked on carol's own new file, from "
            f"carol's own symlinked daemon: {stranger_blocked}"
        )
        assert stranger_blocked.get("holder") == "sess-carol"
    finally:
        if claim:
            await claim["ws"].close()
        for d in daemons:
            d.stop()
        await relay.stop()


async def test_daemon_that_never_joins_fails_readably(tmp_path, sockdir):
    """presenced_proc.py already raises readably on a socket path over 90
    bytes and on an early process exit. The gap: a daemon that starts,
    binds both its sockets fine, and then just never manages to join the
    relay room (refused, wrong port, connection reset) answers every
    decide() call exactly the way a genuinely-absent lease does — rung
    stays 0 forever — so a plain poll-and-timeout here would read as "no
    conflict" instead of "this daemon is broken". recent_output() is the
    difference.
    """
    binary = find_or_build_presenced(tmp_path / "bin")
    # Bind a port, learn its number, close it — so "nothing is listening here"
    # is a fact this test established rather than a guess about a fixed number.
    # A hardcoded port is a lie the moment anything else on the machine happens
    # to hold it, and this suite now runs before every PR, often beside other
    # agents' processes.
    with socket.socket() as probe:
        probe.bind(("127.0.0.1", 0))
        dead_relay = f"ws://127.0.0.1:{probe.getsockname()[1]}"
    orphan = start_presenced(binary, cwd=str(tmp_path), relay_url=dead_relay,
                             room=ROOM, sock=str(sockdir / "orphan.sock"))
    try:
        with pytest.raises(AssertionError) as excinfo:
            _poll_blocked(orphan, path="src/orders.py", agent="sess-nobody",
                         human="nobody", deadline=1.5)
        msg = str(excinfo.value)
        assert any(s in msg for s in ("connect failed", "backing off")), (
            f"the timeout didn't explain itself with presenced's own log:\n{msg}"
        )
    finally:
        orphan.stop()


async def test_sock_override_redirects_journal_snapshot_and_statusline(
        two_checkouts, tmp_path, sockdir):
    """#90's whole premise, driven by the real binary: presenced derives its
    journal and snapshot from AGENT_SYNC_SOCK (siblingPath,
    go/cmd/presenced/main.go), and every reader hanging off that socket has
    to land on the same two files or it silently answers for whichever
    daemon happened to own the fixed name.

    The snapshot is written once up front, before this daemon ever joins a
    room (daemon.go), so that half needs no relay. The journal is only
    written for a real conflict (rung > 0 — journal.Journal.Record drops
    everything else), so this reuses the claim-then-collide shape every
    other test in this module drives against the real gorelay.
    """
    carol, _dan = two_checkouts
    binary = find_or_build_presenced(tmp_path / "bin")
    relay = await start_gorelay()
    sock = str(sockdir / "ap2.sock")
    claim = None
    daemon = start_presenced(binary, cwd=str(carol), relay_url=relay.url,
                             room=ROOM, sock=sock)
    try:
        claim = await _claim(relay.url, "sess-carol", "carol", FILE)
        assert claim["granted"], "carol's claim was refused"

        journal_file = sockdir / "ap2.decisions.jsonl"
        snapshot_file = sockdir / "ap2.json"
        assert snapshot_file.exists(), (
            f"daemon never wrote its sibling snapshot:\n{daemon.recent_output()}"
        )

        blocked = _poll_blocked(daemon, path=str(carol / FILE),
                                agent="sess-dan", human="dan")
        assert blocked.get("rung") == 3, (
            f"never saw a conflict to journal: {blocked}"
        )

        deadline = time.monotonic() + 5.0
        while time.monotonic() < deadline and not journal_file.exists():
            time.sleep(0.05)
        assert journal_file.exists(), (
            f"daemon never wrote its sibling journal:\n{daemon.recent_output()}"
        )

        env = {"AGENT_SYNC_SOCK": sock}
        assert journal_mod.journal_path(env) == journal_file
        assert paths_mod.snapshot_path(env) == snapshot_file

        # A file sitting at the old fixed name, from a first daemon on this
        # box — the exact collision #90 is about. The real daemon above
        # wrote an empty peer list to its own sibling snapshot; the
        # statusline has to read that, not this one.
        (sockdir / "agent-sync.json").write_text(
            '{"peers":[{"human":"wrong-daemon","verb":"edit","path":"x"}]}'
        )
        r = subprocess.run(
            [str(STATUSLINE)], capture_output=True, text=True, timeout=10,
            env={"PATH": os.environ.get("PATH", "/usr/bin:/bin"),
                 "AGENT_SYNC_SOCK": sock},
        )
        assert r.returncode == 0
        assert r.stdout.strip() == "", (
            f"statusline read the wrong daemon's snapshot: {r.stdout!r}"
        )
    finally:
        if claim:
            await claim["ws"].close()
        daemon.stop()
        await relay.stop()
