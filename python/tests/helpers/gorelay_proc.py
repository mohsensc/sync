"""Spawns the real `gorelay` binary as a subprocess and hands back a
`(url, proc)`-shaped fixture, in place of `agent_sync.serve.serve`
running the (now-deleted) Python relay in-process.

This is the black-box parity harness docs/relay-parity.md and
docs/languages.md's "dual-relay problem" section both name: the one that
produced the 13/14 real-socket result and the golden-scenario diff, and
that lived in a scratch dir instead of the repo. Checked in here so it
runs as part of scripts/ci-local.sh's python job instead of depending on
someone re-running it by hand before trusting a change to the relay.

Every test file that uses this swaps its `server`/`roster_server` fixture
body for one that calls `start_gorelay()` — the test *functions* below
those fixtures (the actual `test_*` assertions) are unchanged from when
they drove `agent_sync.serve.serve` against the Python relay, because
none of them touch the `relay` object the old fixtures also yielded, only
the wire.
"""

from __future__ import annotations

import asyncio
import contextlib
import os
import re
import shutil
import subprocess
from pathlib import Path

_LISTEN_RE = re.compile(rb"relay listening on (\S+)")

# python/tests/helpers/gorelay_proc.py -> repo root is three parents up.
_REPO_ROOT = Path(__file__).resolve().parents[3]
_GO_DIR = _REPO_ROOT / "go"


def _find_or_build_gorelay() -> str:
    """Where the gorelay binary comes from, checked in the order an
    operator (or ci-local.sh) would expect: an explicit override via the
    AGENT_SYNC_GORELAY_BIN env var, a release build already sitting in
    go/bin, or a plain `go build` on demand — the same fallback
    go/internal/relay's own integration test uses, so a bare `pytest` needs
    nothing pre-built, only `go` on PATH.
    """
    override = os.environ.get("AGENT_SYNC_GORELAY_BIN", "").strip()
    if override:
        return override
    candidate = _GO_DIR / "bin" / "gorelay"
    if candidate.exists():
        return str(candidate)
    found = shutil.which("gorelay")
    if found:
        return found
    if shutil.which("go") is None:
        raise RuntimeError(
            "no gorelay binary and no 'go' on PATH — the black-box suite "
            "needs one or the other. Build it: cd go && go build -o "
            "bin/gorelay ./cmd/gorelay"
        )
    candidate.parent.mkdir(parents=True, exist_ok=True)
    subprocess.run(
        ["go", "build", "-o", str(candidate), "./cmd/gorelay"],
        cwd=_GO_DIR, check=True,
    )
    return str(candidate)


class GoRelayProc:
    """A running `gorelay`, bound to an ephemeral port. Shaped like the
    `srv` object serve()'s `on_ready` callback used to hand a fixture —
    `.sockets[0].getsockname()[1]` — so existing on_ready callbacks in the
    fixtures below need no further change than swapping what starts them.
    """

    def __init__(
        self, port: int, proc: "asyncio.subprocess.Process", drain: "asyncio.Task"
    ) -> None:
        self._port = port
        self._proc = proc
        self._drain = drain

    def getsockname_port(self) -> int:
        return self._port

    @property
    def port(self) -> int:
        return self._port

    @property
    def url(self) -> str:
        return f"ws://127.0.0.1:{self._port}"

    async def stop(self) -> None:
        with contextlib.suppress(ProcessLookupError):
            self._proc.terminate()
        with contextlib.suppress(asyncio.TimeoutError):
            await asyncio.wait_for(self._proc.wait(), timeout=5)
        if self._proc.returncode is None:
            with contextlib.suppress(ProcessLookupError):
                self._proc.kill()
            with contextlib.suppress(asyncio.TimeoutError):
                await asyncio.wait_for(self._proc.wait(), timeout=5)
        self._drain.cancel()
        with contextlib.suppress(asyncio.CancelledError, Exception):
            await self._drain


async def start_gorelay(
    *, env: dict | None = None, timeout: float = 10.0, port: int = 0,
) -> GoRelayProc:
    """Start gorelay on 127.0.0.1:0 and wait for its listen line.

    `env` extends the current process's environment — the roster and org
    policy fixtures below use it to point AGENT_SYNC_PRINCIPALS /
    AGENT_SYNC_ORG_POLICY at a temp file before the process starts,
    which is the only way any operator can actually set either one (an
    env var set after a child exists is invisible to it — the exact
    harness artifact docs/relay-parity.md's black-box run hit and worked
    around for opaque mode; setting it before spawn here avoids it rather
    than working around it again).
    """
    bin_path = _find_or_build_gorelay()
    full_env = dict(os.environ)
    if env:
        full_env.update(env)

    proc = await asyncio.create_subprocess_exec(
        bin_path, "--host", "127.0.0.1", "--port", str(port),
        stdout=asyncio.subprocess.DEVNULL,
        stderr=asyncio.subprocess.PIPE,
        env=full_env,
    )
    assert proc.stderr is not None

    # A pipe nobody reads fills its OS buffer and then blocks the child's
    # next write to it — the exact class of bug this PR fixed on the
    # relay's own outbound side (server.go's write()). gorelay logs one
    # line per connection event, so a test file with more than a handful
    # of connects/disconnects reaches that buffer eventually if nothing
    # keeps draining stderr after the one line this function cares about.
    port_found: asyncio.Future = asyncio.get_running_loop().create_future()

    async def _drain_stderr() -> None:
        while True:
            line = await proc.stderr.readline()
            if not line:
                if not port_found.done():
                    port_found.set_exception(RuntimeError(
                        "gorelay exited before printing a listen line "
                        f"(exit code {proc.returncode})"
                    ))
                return
            if not port_found.done():
                m = _LISTEN_RE.search(line)
                if m:
                    addr = m.group(1).decode()
                    port_found.set_result(int(addr.rsplit(":", 1)[1]))

    drain_task = asyncio.create_task(_drain_stderr())

    try:
        port = await asyncio.wait_for(port_found, timeout=timeout)
    except (asyncio.TimeoutError, RuntimeError):
        drain_task.cancel()
        with contextlib.suppress(ProcessLookupError):
            proc.kill()
        raise
    return GoRelayProc(port, proc, drain_task)
