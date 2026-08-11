"""Plumbing for the load and chaos harness.

Process control, a websocket client that talks the relay's wire protocol, and
the small amount of stats machinery the scenarios print. Nothing in here knows
what any particular scenario is testing.
"""

from __future__ import annotations

import asyncio
import contextlib
import json
import os
import signal
import socket
import ssl
import subprocess
import time
from collections import Counter
from dataclasses import dataclass, field
from pathlib import Path

import websockets

ROOT = Path(__file__).resolve().parents[2]
VENV_PY = ROOT / "python" / ".venv" / "bin" / "python"
CPP_BUILD = ROOT / "cpp" / "build"
AP_HOOK = CPP_BUILD / "ap-hook"
# The daemon is Go now (#18) — the hook stays C++, see docs/gohook-spike.md.
# run.py's preflight builds this from go/cmd/presenced if it is stale.
GO_BUILD = ROOT / "tests" / "load" / "build"

# -- TLS (#22) ------------------------------------------------------------
#
# AP_LOAD_TLS=1 flips every RelayProc/Client/DaemonProc in this run onto a
# self-signed dev cert over wss:// instead of ws:// — the same recipe
# docs/tls-dev-cert.md documents, generated once and reused for the run
# rather than per scenario. Nothing here changes what a scenario measures;
# it changes the transport every scenario measures it over. Off by
# default, so every existing invocation of run.py is unaffected.
TLS_ENABLED = os.environ.get("AP_LOAD_TLS") == "1"
_TLS_DIR = GO_BUILD / "tls"
_TLS_CERT = _TLS_DIR / "relay-cert.pem"
_TLS_KEY = _TLS_DIR / "relay-key.pem"
_tls_client_ctx: ssl.SSLContext | None = None


def ensure_dev_cert() -> tuple[Path, Path]:
    """The cert/key pair every TLS-enabled process in this run shares.
    Generated once; a run that only ever reads AP_LOAD_TLS through this
    function never regenerates it mid-run."""
    if not (_TLS_CERT.exists() and _TLS_KEY.exists()):
        _TLS_DIR.mkdir(parents=True, exist_ok=True)
        subprocess.run(
            ["openssl", "req", "-x509", "-newkey", "ec",
             "-pkeyopt", "ec_paramgen_curve:prime256v1",
             "-keyout", str(_TLS_KEY), "-out", str(_TLS_CERT),
             "-days", "1", "-nodes", "-subj", "/CN=agent-presence-load-test",
             "-addext", "subjectAltName=DNS:localhost,IP:127.0.0.1"],
            check=True, capture_output=True,
        )
    return _TLS_CERT, _TLS_KEY


def dev_client_ssl_context() -> ssl.SSLContext:
    """A client context that trusts exactly the dev cert above — real
    verification (not `CERT_NONE`), scoped to the one cert this run
    generated, matching what an operator following docs/tls-dev-cert.md
    would set up with AGENT_PRESENCE_RELAY_CA."""
    global _tls_client_ctx
    if _tls_client_ctx is None:
        cert, _ = ensure_dev_cert()
        _tls_client_ctx = ssl.create_default_context(cafile=str(cert))
    return _tls_client_ctx
PRESENCED = GO_BUILD / "presenced"
BOOT = Path(__file__).resolve().parent / "_relay_boot.py"


# -- stats --------------------------------------------------------------------


def pct(samples: list[float], q: float) -> float:
    """Nearest-rank percentile. Empty gives 0 so a scenario that measured
    nothing prints a zero instead of blowing up in the summary."""
    if not samples:
        return 0.0
    s = sorted(samples)
    i = min(len(s) - 1, max(0, int(round(q * len(s))) - 1))
    return s[i]


@dataclass
class Latency:
    name: str
    samples: list[float] = field(default_factory=list)

    def add(self, ms: float) -> None:
        self.samples.append(ms)

    def row(self) -> dict:
        return {
            "n": len(self.samples),
            "p50_ms": round(pct(self.samples, 0.50), 3),
            "p95_ms": round(pct(self.samples, 0.95), 3),
            "p99_ms": round(pct(self.samples, 0.99), 3),
            "max_ms": round(max(self.samples), 3) if self.samples else 0.0,
        }


def free_port() -> int:
    """A port nothing is listening on right now. Racy by nature, but we bind it
    for real immediately after and the relay restart scenarios need a port that
    stays the same across a kill."""
    s = socket.socket()
    s.bind(("127.0.0.1", 0))
    port = s.getsockname()[1]
    s.close()
    return port


def rss_kb(pid: int) -> int:
    """Resident set of a pid, in KiB, or 0 if it is gone. `ps` rather than
    psutil because the harness must not add a dependency to run."""
    try:
        out = subprocess.run(
            ["ps", "-o", "rss=", "-p", str(pid)],
            capture_output=True, text=True, timeout=5,
        )
        return int(out.stdout.strip() or 0)
    except Exception:
        return 0


def cpu_seconds(pid: int) -> float:
    try:
        out = subprocess.run(
            ["ps", "-o", "time=", "-p", str(pid)],
            capture_output=True, text=True, timeout=5,
        )
        raw = out.stdout.strip()
        if not raw:
            return 0.0
        parts = [float(p) for p in raw.replace("-", ":").split(":")]
        total = 0.0
        for p in parts:
            total = total * 60 + p
        return total
    except Exception:
        return 0.0


# -- the relay ----------------------------------------------------------------


class RelayProc:
    """The Python relay in its own process, so it can be measured and killed.

    Goes through _relay_boot.py rather than the console script: some scenarios
    need a lease TTL shorter than 90 seconds to observe expiry at all, and the
    TTL is a module constant with no knob on it.
    """

    def __init__(self, port: int | None = None, *, lease_ttl_s: float | None = None,
                 log_level: str = "WARNING") -> None:
        self.port = port or free_port()
        self.lease_ttl_s = lease_ttl_s
        self.log_level = log_level
        self.proc: subprocess.Popen | None = None
        self.log = ROOT / "tests" / "load" / f".relay-{self.port}.log"

    @property
    def url(self) -> str:
        scheme = "wss" if TLS_ENABLED else "ws"
        return f"{scheme}://127.0.0.1:{self.port}"

    def start(self) -> None:
        env = dict(os.environ)
        env["AGENT_PRESENCE_PORT"] = str(self.port)
        env["AGENT_PRESENCE_LOG_LEVEL"] = self.log_level
        env["PYTHONPATH"] = str(ROOT / "python" / "src")
        if self.lease_ttl_s is not None:
            env["AP_LOAD_LEASE_TTL_S"] = str(self.lease_ttl_s)
        if TLS_ENABLED:
            cert, key = ensure_dev_cert()
            env["AGENT_PRESENCE_TLS_CERT"] = str(cert)
            env["AGENT_PRESENCE_TLS_KEY"] = str(key)
        self.log.parent.mkdir(parents=True, exist_ok=True)
        fh = open(self.log, "wb")
        self.proc = subprocess.Popen(
            [str(VENV_PY), str(BOOT)], env=env, stdout=fh, stderr=fh,
        )
        self.wait_ready()

    def wait_ready(self, timeout: float = 20.0) -> None:
        end = time.time() + timeout
        while time.time() < end:
            try:
                s = socket.create_connection(("127.0.0.1", self.port), 0.25)
                s.close()
                return
            except OSError:
                if self.proc is not None and self.proc.poll() is not None:
                    raise RuntimeError(
                        f"relay died on startup: {self.log.read_text()[-2000:]}")
                time.sleep(0.05)
        raise TimeoutError(f"relay never bound {self.port}")

    @property
    def pid(self) -> int:
        return self.proc.pid if self.proc else 0

    def alive(self) -> bool:
        return self.proc is not None and self.proc.poll() is None

    def sigkill(self) -> None:
        if self.proc is not None and self.proc.poll() is None:
            self.proc.send_signal(signal.SIGKILL)
            self.proc.wait(timeout=10)
        # The socket has to actually be gone before a restart can bind it.
        end = time.time() + 5
        while time.time() < end:
            try:
                s = socket.create_connection(("127.0.0.1", self.port), 0.1)
                s.close()
                time.sleep(0.05)
            except OSError:
                return

    def stop(self) -> None:
        if self.proc is None:
            return
        if self.proc.poll() is None:
            self.proc.send_signal(signal.SIGTERM)
            try:
                self.proc.wait(timeout=5)
            except subprocess.TimeoutExpired:
                self.proc.kill()
                self.proc.wait(timeout=5)

    def log_tail(self, n: int = 40) -> str:
        try:
            return "\n".join(self.log.read_text().splitlines()[-n:])
        except Exception:
            return ""


# -- presenced ----------------------------------------------------------------


class DaemonProc:
    """One presenced, with its own socket, snapshot and identity."""

    def __init__(self, tmp: Path, name: str, room: str, relay_url: str) -> None:
        self.name = name
        self.room = room
        self.relay_url = relay_url
        self.dir = tmp / name
        self.dir.mkdir(parents=True, exist_ok=True)
        self.sock = self.dir / "ap.sock"
        self.snapshot = self.dir / "ap.json"
        self.log = self.dir / "presenced.log"
        self.proc: subprocess.Popen | None = None

    def start(self) -> None:
        env = dict(os.environ)
        env.update({
            "AGENT_PRESENCE_SOCK": str(self.sock),
            "AGENT_PRESENCE_SNAPSHOT": str(self.snapshot),
            "AGENT_PRESENCE_ROOM": self.room,
            "AGENT_PRESENCE_RELAY": self.relay_url,
            "AGENT_PRESENCE_AGENT": self.name,
            "AGENT_PRESENCE_HUMAN": f"human-{self.name}",
        })
        if TLS_ENABLED and self.relay_url.startswith("wss://"):
            # Real verification against the run's dev cert, not skip-verify
            # — this is what proves the Go client's default TLS dial path,
            # not just that the flag exists.
            cert, _ = ensure_dev_cert()
            env["AGENT_PRESENCE_RELAY_CA"] = str(cert)
        fh = open(self.log, "wb")
        self.proc = subprocess.Popen([str(PRESENCED)], env=env, stdout=fh, stderr=fh)
        end = time.time() + 10
        while time.time() < end:
            if self.sock.exists():
                return
            if self.proc.poll() is not None:
                raise RuntimeError(f"{self.name} died on startup")
            time.sleep(0.02)
        raise TimeoutError(f"{self.name} never created {self.sock}")

    def alive(self) -> bool:
        return self.proc is not None and self.proc.poll() is None

    @property
    def pid(self) -> int:
        return self.proc.pid if self.proc else 0

    def snapshot_paths(self) -> dict[str, str]:
        """What the statusline would render: agent human -> last path seen.

        Doubles as a probe for how much of a batch the daemon actually read,
        because the table records the most recent line it processed.
        """
        try:
            data = json.loads(self.snapshot.read_text())
        except Exception:
            return {}
        return {p.get("human", ""): p.get("path", "")
                for p in data.get("peers", [])}

    def send_lines(self, lines: list[str], timeout: float = 2.0) -> bool:
        """One connection, every line, the way a burst of hooks would look if
        they shared a socket. Returns False if the daemon would not take it."""
        try:
            s = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
            s.settimeout(timeout)
            s.connect(str(self.sock))
            s.sendall(("\n".join(lines) + "\n").encode())
            s.close()
            return True
        except OSError:
            return False

    def sigkill(self) -> None:
        if self.proc is not None and self.proc.poll() is None:
            self.proc.send_signal(signal.SIGKILL)
            self.proc.wait(timeout=10)

    def stop(self) -> None:
        if self.proc is None:
            return
        if self.proc.poll() is None:
            self.proc.send_signal(signal.SIGTERM)
            try:
                self.proc.wait(timeout=5)
            except subprocess.TimeoutExpired:
                self.proc.kill()
                self.proc.wait(timeout=5)


def event_line(agent: str, verb: str, path: str, human: str = "") -> str:
    """The line ap-hook writes to the daemon socket.

    The Go daemon parses this with encoding/json, so spacing is no longer
    load-bearing on that side (it was, when the daemon read it with a
    hand-rolled scanner — see #19). Kept compact anyway because it is what
    the real hook actually emits (json.dumps on the C++ side has no
    whitespace either), and matching that keeps this harness measuring the
    real wire shape rather than a friendlier one.
    """
    return json.dumps(
        {"verb": verb, "agent": agent, "human": human or agent, "path": path},
        separators=(",", ":"),
    )


# -- a relay client -----------------------------------------------------------


class Client:
    """One websocket connection, i.e. one daemon or one MCP session.

    A reader task pulls everything off the socket so the connection never
    backs up, sorts replies from fan-out, and counts the rest. Scenarios read
    the counters; nothing here asserts anything.
    """

    def __init__(self, url: str, room: str, agent: str, human: str = "") -> None:
        self.url = url
        self.room = room
        self.agent = agent
        self.human = human or f"human-{agent}"
        self.ws = None
        self.kinds: Counter[str] = Counter()
        self.fanout: list[dict] = []     # lease/leases/presence frames, kept
        self.keep_fanout = False
        self.errors: list[str] = []
        # Set to the prefix every agent id in this connection's room shares.
        # Anything else naming an agent is a room leaking into another room.
        self.expect_prefix: str | None = None
        self.isolation_violations: list[dict] = []
        self._replies: asyncio.Queue = asyncio.Queue()
        self._acks: asyncio.Queue = asyncio.Queue()
        self._reader: asyncio.Task | None = None
        self.closed_early = False

    async def connect(self) -> None:
        ssl_ctx = dev_client_ssl_context() if TLS_ENABLED else None
        self.ws = await websockets.connect(
            self.url, open_timeout=30, ping_interval=None, max_queue=None,
            ssl=ssl_ctx,
        )
        self._reader = asyncio.create_task(self._read_loop())
        await self.ws.send(json.dumps({"type": "join", "room": self.room,
                                       "agent": self.agent, "human": self.human}))

    async def _read_loop(self) -> None:
        try:
            async for raw in self.ws:
                try:
                    msg = json.loads(raw)
                except Exception:
                    self.errors.append("undecodable frame from relay")
                    continue
                kind = msg.get("type", "?")
                self.kinds[kind] += 1
                if self.expect_prefix is not None:
                    self._check_isolation(msg)
                if kind in ("claim_result", "move_result"):
                    self._replies.put_nowait(msg)
                elif kind in ("ack", "negotiate"):
                    self._acks.put_nowait(msg)
                elif self.keep_fanout:
                    self.fanout.append(msg)
        except websockets.exceptions.ConnectionClosed:
            self.closed_early = True
        except Exception as exc:  # pragma: no cover - diagnostic only
            self.errors.append(f"reader died: {exc!r}")
            self.closed_early = True

    def _check_isolation(self, msg: dict) -> None:
        names = [msg.get("agent"), msg.get("held_by")]
        for lease in msg.get("leases") or []:
            if isinstance(lease, dict):
                names.append(lease.get("agent"))
        for name in names:
            if isinstance(name, str) and name and \
                    not name.startswith(self.expect_prefix) and \
                    not name.startswith("probe"):
                self.isolation_violations.append(
                    {"receiver": self.agent, "room": self.room, "frame": msg})
                return

    async def _send(self, payload: dict) -> None:
        await self.ws.send(json.dumps(payload))

    @staticmethod
    def region(path: str, symbol: str | None = None) -> dict:
        return {"path": path, "symbol": symbol, "lines": None}

    async def claim(self, path: str, symbol: str | None = None, intent: str = "work",
                    timeout: float = 30.0) -> tuple[dict, float]:
        t0 = time.perf_counter()
        await self._send({"type": "claim", "region": self.region(path, symbol),
                          "intent": intent})
        reply = await asyncio.wait_for(self._replies.get(), timeout)
        return reply, (time.perf_counter() - t0) * 1000.0

    async def release(self, path: str, symbol: str | None = None) -> None:
        await self._send({"type": "release", "region": self.region(path, symbol)})

    async def heartbeat(self, path: str, symbol: str | None = None) -> None:
        await self._send({"type": "heartbeat", "region": self.region(path, symbol)})

    async def event(self, verb: str, path: str, timeout: float = 30.0
                    ) -> tuple[dict, float]:
        t0 = time.perf_counter()
        await self._send({"type": "event", "verb": verb,
                          "region": self.region(path)})
        reply = await asyncio.wait_for(self._acks.get(), timeout)
        return reply, (time.perf_counter() - t0) * 1000.0

    async def fire_and_forget_event(self, verb: str, path: str) -> None:
        await self._send({"type": "event", "verb": verb,
                          "region": self.region(path)})

    async def close(self) -> None:
        with contextlib.suppress(Exception):
            await self.ws.close()
        if self._reader is not None:
            self._reader.cancel()
            with contextlib.suppress(BaseException):
                await self._reader


async def probe_leases(url: str, room: str, agent: str = "probe",
                       settle: float = 1.0) -> list[dict]:
    """What the relay still thinks is held in a room.

    There is no admin endpoint, so this uses the one read the protocol does
    offer: a fresh joiner is handed a `leases` snapshot, and an empty room
    sends nothing at all.
    """
    c = Client(url, room, agent)
    c.keep_fanout = True
    await c.connect()
    await asyncio.sleep(settle)
    await c.close()
    for frame in c.fanout:
        if frame.get("type") == "leases":
            return frame.get("leases", [])
    return []
