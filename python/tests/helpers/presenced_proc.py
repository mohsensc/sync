"""Spawns the real `presenced` binary, the way gorelay_proc.py spawns the
relay.

It exists for one test that nothing else in this repo could express: two
teammates, two checkouts of one repo, one relay, and the question of whether
they collide on the same file. Every other suite tests one process at a time,
which is exactly how a region key that only worked inside a single filesystem
survived to ship.
"""

from __future__ import annotations

import collections
import json
import os
import shutil
import socket
import subprocess
import threading
import time
from pathlib import Path

# python/tests/helpers/presenced_proc.py -> repo root is three parents up.
_REPO_ROOT = Path(__file__).resolve().parents[3]
_GO_DIR = _REPO_ROOT / "go"

# How many of presenced's own log lines to keep around for a failure
# message. presenced logs every relay connect/refuse/backoff through this
# same pipe (see relay/client.go), so a bounded tail is enough to explain a
# daemon that bound its sockets fine and then never actually joined the
# room — the case a plain bind-and-timeout leaves silent.
_LOG_LINES = 200


def find_or_build_presenced(build_dir: Path) -> str:
    """An explicit override via the AGENT_SYNC_PRESENCED_BIN env var,
    else a build into a caller-owned directory.

    Deliberately not go/bin: two agents (or two `pytest` runs) in one checkout
    would race on the same output path, which is the collision this file's own
    test is about.
    """
    override = os.environ.get("AGENT_SYNC_PRESENCED_BIN", "").strip()
    if override:
        return override
    if shutil.which("go") is None:
        raise RuntimeError(
            "no presenced binary and no 'go' on PATH — set "
            "AGENT_SYNC_PRESENCED_BIN or install Go"
        )
    build_dir.mkdir(parents=True, exist_ok=True)
    out = build_dir / "presenced"
    subprocess.run(
        ["go", "build", "-o", str(out), "./cmd/presenced"],
        cwd=_GO_DIR, check=True,
    )
    return str(out)


class _LogTail:
    """A bounded ring of presenced's own log lines, safe to read while the
    drain thread below is still appending to it.

    collections.deque raises "deque mutated during iteration" if you
    iterate it (str.join does) on one thread while another appends — and
    recent_output() is exactly the thing a caller reaches for while
    presenced is mid-retry against a dead relay, i.e. while the drain
    thread is actively appending. The lock is only ever held for an
    append or a join, never across a socket call, so it costs nothing
    decide() would notice.
    """

    def __init__(self, maxlen: int) -> None:
        self._lines: "collections.deque[str]" = collections.deque(maxlen=maxlen)
        self._lock = threading.Lock()

    def append(self, line: str) -> None:
        with self._lock:
            self._lines.append(line)

    def render(self) -> str:
        with self._lock:
            return "\n".join(self._lines)


def _drain_stdout(proc: subprocess.Popen, log: "_LogTail") -> None:
    """Keep presenced's combined stdout/stderr pipe empty for the life of
    the process, into a bounded ring buffer.

    Two reasons, not one. First, the same reason gorelay_proc.py's
    _drain_stderr exists: a pipe nobody reads fills its OS buffer and then
    blocks the child's next write to it. Second, and the reason this
    function exists where the old code got away with a one-shot read on
    exit: presenced logs its relay connection state — connecting,
    connected, refused, backing off — through this pipe for as long as it
    runs, not just when it dies. A daemon that binds its sockets fine and
    then never manages to join the room looks, from the test's decide()
    calls alone, identical to one that joined and simply saw no lease.
    This tail is what tells the two apart.
    """
    stream = proc.stdout
    if stream is None:
        return
    for line in iter(stream.readline, ""):
        log.append(line.rstrip("\n"))


class PresencedProc:
    """One running daemon, with its socket, its own sibling files, and a
    tail of its own log output."""

    def __init__(self, proc: subprocess.Popen, sock: str,
                 log: "_LogTail") -> None:
        self._proc = proc
        self.sock = sock
        self._log = log

    def event(self, *, verb: str, path: str, agent: str, human: str) -> None:
        """One line on the event socket — what the hook writes for a
        PostToolUse call it expects no answer to."""
        self._send(self.sock, {"verb": verb, "path": path,
                               "agent": agent, "human": human})

    def decide(self, *, verb: str, path: str, agent: str, human: str) -> dict:
        """One line on the decision socket, and the reply — the PreToolUse
        path, byte for byte what cpp/hook/hook.cpp sends."""
        raw = self._send(self.sock + ".decide",
                         {"verb": verb, "path": path, "agent": agent,
                          "human": human, "want": "decision"},
                         read_reply=True)
        return json.loads(raw) if raw else {}

    @staticmethod
    def _send(sock_path: str, payload: dict, read_reply: bool = False) -> str:
        s = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        s.settimeout(5)
        try:
            s.connect(sock_path)
            s.sendall((json.dumps(payload) + "\n").encode())
            if not read_reply:
                return ""
            buf = b""
            while not buf.endswith(b"\n"):
                chunk = s.recv(65536)
                if not chunk:
                    break
                buf += chunk
            return buf.decode().strip()
        finally:
            s.close()

    def recent_output(self) -> str:
        """The tail of presenced's own stdout/stderr — what actually
        happened on the relay connection, for a caller that only has a
        decide() reply stuck at rung 0 to go on."""
        return self._log.render()

    def stop(self) -> None:
        self._proc.terminate()
        try:
            self._proc.wait(timeout=5)
        except subprocess.TimeoutExpired:
            self._proc.kill()
            self._proc.wait(timeout=5)


def start_presenced(binary: str, *, cwd: str, relay_url: str, room: str,
                    sock: str, timeout: float = 10.0) -> PresencedProc:
    """Start a daemon in `cwd` and wait for both its sockets to appear.

    cwd is the checkout: it is what the daemon walks up from to find the repo
    root, and therefore what every region key it sends is relative to.

    Binding the sockets and joining the relay room are independent: the
    hook sockets come up before the relay client's first connect attempt,
    so this returns as soon as a daemon can answer decide() at all, whether
    or not it ever manages to join a room. A caller that needs the room
    joined has to poll for that itself.
    """
    env = dict(os.environ)
    env.update({
        "AGENT_SYNC_RELAY": relay_url,
        "AGENT_SYNC_ROOM": room,
        "AGENT_SYNC_SOCK": sock,
    })
    # Stock identity: no manual agent override, and no session id — a daemon
    # serves many sessions and is not any one of them.
    env.pop("AGENT_SYNC_AGENT", None)
    env.pop("CLAUDE_CODE_SESSION_ID", None)

    # A unix socket path is capped near 104 bytes on macOS and 108 on Linux,
    # and pytest's tmp_path is nowhere near short enough. Fail with the reason
    # rather than with a bind error nobody can read.
    if len(sock) > 90:
        raise RuntimeError(
            f"socket path is {len(sock)} bytes, too long for AF_UNIX: {sock}"
        )

    proc = subprocess.Popen([binary], cwd=cwd, env=env,
                            stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                            text=True)
    log = _LogTail(_LOG_LINES)
    threading.Thread(target=_drain_stdout, args=(proc, log), daemon=True).start()

    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if os.path.exists(sock) and os.path.exists(sock + ".decide"):
            return PresencedProc(proc, sock, log)
        if proc.poll() is not None:
            raise RuntimeError(
                f"presenced exited with {proc.returncode} before binding "
                f"{sock}:\n" + log.render()
            )
        time.sleep(0.05)
    proc.kill()
    raise RuntimeError(
        f"presenced never bound {sock} within {timeout}s — recent output:\n"
        + log.render()
    )
