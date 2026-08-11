"""The launchable surface: `python -m` and the console scripts.

These all start real processes. Importing a module proves nothing about whether
it runs — the whole reason this file exists is that `python -m
agent_presence.serve` used to import fine and exit 0 without binding anything.
"""

from __future__ import annotations

import asyncio
import contextlib
import json
import os
import re
import signal
import socket
import subprocess
import sys
import time
import tomllib
from importlib import import_module
from pathlib import Path

import pytest
import websockets

PYTHON_ROOT = Path(__file__).resolve().parents[1]
PYPROJECT = PYTHON_ROOT / "pyproject.toml"
BIN_DIR = Path(sys.executable).parent

# Generous: a cold subprocess import of websockets is not fast.
BOOT_TIMEOUT_S = 30.0
LISTENING = re.compile(r"agent_presence\.serve relay listening on ([^\s:]+):(\d+)")


def _free_port() -> int:
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


def _clean_env(**extra: str) -> dict[str, str]:
    env = {k: v for k, v in os.environ.items()
           if not k.startswith("AGENT_PRESENCE_")}
    env.update(extra)
    return env


class Relay:
    """A relay in its own process, with the port it actually bound."""

    def __init__(self, proc: subprocess.Popen, host: str, port: int) -> None:
        self.proc = proc
        self.host = host
        self.port = port

    @property
    def url(self) -> str:
        return f"ws://{self.host}:{self.port}"


@contextlib.contextmanager
def relay_process(argv: list[str], env: dict[str, str] | None = None):
    proc = subprocess.Popen(
        [sys.executable, "-m", "agent_presence.serve", *argv],
        cwd=PYTHON_ROOT,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        env=env or _clean_env(),
    )
    try:
        host, port = _await_listening(proc)
        yield Relay(proc, host, port)
    finally:
        if proc.poll() is None:
            proc.send_signal(signal.SIGTERM)
            with contextlib.suppress(subprocess.TimeoutExpired):
                proc.wait(timeout=BOOT_TIMEOUT_S)
        if proc.poll() is None:
            proc.kill()
            proc.wait(timeout=BOOT_TIMEOUT_S)


def _await_listening(proc: subprocess.Popen) -> tuple[str, int]:
    """Read the bind line off stderr. Port 0 means only the process knows the
    port, so this is also how the caller learns it."""
    end = time.monotonic() + BOOT_TIMEOUT_S
    seen: list[str] = []
    while time.monotonic() < end:
        line = proc.stderr.readline()
        if not line:
            break
        seen.append(line)
        match = LISTENING.search(line)
        if match:
            return match.group(1), int(match.group(2))
    proc.kill()
    raise AssertionError(
        "relay never reported a bound socket. stderr:\n" + "".join(seen)
        + (proc.stderr.read() or "")
    )


async def _round_trip(url: str) -> dict:
    async with websockets.connect(url) as ws:
        await ws.send(json.dumps({"type": "join", "room": "r1",
                                  "agent": "a1", "human": "sara"}))
        await ws.send(json.dumps({
            "type": "event", "verb": "edit", "source": "hook",
            "region": {"path": "src/auth.py", "symbol": "sign_in", "lines": None},
        }))
        # The join is answered with a lease snapshot before the event's ack.
        while True:
            frame = json.loads(await asyncio.wait_for(ws.recv(), timeout=10))
            if frame.get("type") != "leases":
                return frame


# -- the relay runs ---------------------------------------------------------


async def test_python_m_serve_binds_and_answers_a_real_client():
    with relay_process(["--host", "127.0.0.1", "--port", "0"]) as relay:
        assert relay.proc.poll() is None, "relay exited instead of serving"
        reply = await _round_trip(relay.url)
        assert reply["type"] == "ack"


async def test_serve_takes_host_and_port_from_the_environment():
    port = _free_port()
    env = _clean_env(AGENT_PRESENCE_HOST="127.0.0.1",
                     AGENT_PRESENCE_PORT=str(port))
    with relay_process([], env=env) as relay:
        assert relay.port == port
        reply = await _round_trip(relay.url)
        assert reply["type"] == "ack"


async def test_argv_beats_the_environment():
    env_port, argv_port = _free_port(), _free_port()
    env = _clean_env(AGENT_PRESENCE_PORT=str(env_port))
    with relay_process(["--port", str(argv_port)], env=env) as relay:
        assert relay.port == argv_port


@pytest.mark.parametrize("sig", [signal.SIGINT, signal.SIGTERM])
async def test_a_signal_shuts_the_relay_down_cleanly(sig):
    with relay_process(["--port", "0"]) as relay:
        # A live connection must not stop the shutdown. It used to be the
        # obvious way to hang on close.
        async with websockets.connect(relay.url):
            relay.proc.send_signal(sig)
            for _ in range(int(BOOT_TIMEOUT_S * 20)):
                if relay.proc.poll() is not None:
                    break
                await asyncio.sleep(0.05)
        assert relay.proc.poll() == 0, "relay did not exit 0 on a signal"
        assert "shutting down" in relay.proc.stderr.read()


async def test_the_port_is_released_when_the_relay_stops():
    port = _free_port()
    for _ in range(2):
        env = _clean_env(AGENT_PRESENCE_PORT=str(port))
        with relay_process([], env=env) as relay:
            assert (await _round_trip(relay.url))["type"] == "ack"


async def test_a_port_already_in_use_fails_loudly_instead_of_exiting_0():
    with socket.socket() as taken:
        taken.bind(("127.0.0.1", 0))
        taken.listen(1)
        port = taken.getsockname()[1]
        proc = subprocess.run(
            [sys.executable, "-m", "agent_presence.serve", "--port", str(port)],
            cwd=PYTHON_ROOT, capture_output=True, text=True,
            timeout=BOOT_TIMEOUT_S, env=_clean_env(),
        )
    assert proc.returncode == 1
    assert "cannot bind" in proc.stderr


@pytest.mark.parametrize(
    ("argv", "env", "expected"),
    [
        (["--port", "not-a-port"], {}, "invalid int value"),
        ([], {"AGENT_PRESENCE_PORT": "not-a-port"}, "must be an integer"),
        (["--log-level", "LOUD"], {}, "unknown log level"),
    ],
)
def test_bad_relay_arguments_are_refused_with_a_message(argv, env, expected):
    proc = subprocess.run(
        [sys.executable, "-m", "agent_presence.serve", *argv],
        cwd=PYTHON_ROOT, capture_output=True, text=True,
        timeout=BOOT_TIMEOUT_S, env=_clean_env(**env),
    )
    assert proc.returncode != 0
    assert expected in proc.stderr


# -- the console scripts ----------------------------------------------------
#
# agent-presence-mcp used to be a console script here, checked the same way
# the two below are. It's a Go binary now (#32) — go/cmd/agent-presence-mcp
# has its own build-and-exec tests for the same claims (starts, speaks the
# protocol, exits cleanly).

EXPECTED_SCRIPTS = {
    "agent-presence-relay": "agent_presence.serve:main",
    "ap": "agent_presence.cli:main",
}


def test_pyproject_declares_every_console_script():
    scripts = tomllib.loads(PYPROJECT.read_text())["project"]["scripts"]
    assert scripts == EXPECTED_SCRIPTS


@pytest.mark.parametrize("target", sorted(EXPECTED_SCRIPTS.values()))
def test_each_console_script_target_resolves_to_a_callable(target):
    module_name, _, attr = target.partition(":")
    entry = getattr(import_module(module_name), attr)
    assert callable(entry)


@pytest.mark.parametrize("name", sorted(EXPECTED_SCRIPTS))
def test_the_installed_console_script_runs(name):
    script = BIN_DIR / name
    assert script.exists(), (
        f"{script} is missing — reinstall with `pip install -e '.[dev]'`"
    )
    proc = subprocess.run([str(script), "--help"], capture_output=True,
                          text=True, timeout=BOOT_TIMEOUT_S, env=_clean_env())
    assert proc.returncode == 0, proc.stderr
    assert name in proc.stdout


def test_the_relay_console_script_serves_the_same_way_the_module_does():
    port = _free_port()
    proc = subprocess.Popen(
        [str(BIN_DIR / "agent-presence-relay"), "--port", str(port)],
        cwd=PYTHON_ROOT, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
        text=True, env=_clean_env(),
    )
    try:
        host, bound = _await_listening(proc)
        assert (host, bound) == ("127.0.0.1", port)
        assert asyncio.run(_round_trip(f"ws://{host}:{bound}"))["type"] == "ack"
    finally:
        proc.send_signal(signal.SIGTERM)
        proc.wait(timeout=BOOT_TIMEOUT_S)



# The MCP server over stdio used to be covered here — a subprocess doing a
# real JSON-RPC handshake, listing its tools, and reaching a real relay
# over `claim_work`. It's a Go binary now (#32);
# go/cmd/agent-presence-mcp/main_test.go builds and execs the real binary
# the same way this file did, for the same claims: the stdio transport
# works, the tool list is right, a claim reaches an actual relay, the
# process exits 0 when its client closes stdin, and only protocol ever
# reaches stdout.
