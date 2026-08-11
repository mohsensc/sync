"""Shared load harness for the relay rewrite spike (issue: does the relay
belong in Go).

Reuses tests/load/_lib.py's process control and websocket client rather than
reinventing them -- same Client, same RelayProc, same percentile math the
existing swarm() scenario uses. What's new here:

  - a member-count curve (200/400/800/1600) instead of one data point
  - relay CPU *and* the load-generator's own CPU, so a client-side ceiling
    doesn't get misread as a relay ceiling
  - a RelayHandle abstraction so the same driver runs against the stock
    python relay, the algorithmic-fix prototype, or the Go prototype

Nothing here patches the product. It only measures.
"""
from __future__ import annotations

import argparse
import asyncio
import contextlib
import json
import os
import resource
import socket
import subprocess
import sys
import time
from dataclasses import dataclass, field
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(ROOT / "tests" / "load"))
sys.path.insert(0, str(ROOT / "python" / "src"))

from _lib import Client, Latency, cpu_seconds, pct, rss_kb  # noqa: E402

VENV_PY = ROOT / "python" / ".venv" / "bin" / "python"
GO_RELAY_BIN = ROOT / "spike" / "relay" / "goprototype" / "gorelayd"


def free_port() -> int:
    s = socket.socket()
    s.bind(("127.0.0.1", 0))
    port = s.getsockname()[1]
    s.close()
    return port


@dataclass
class RelayHandle:
    """One relay under test, whatever its implementation."""

    name: str
    url: str
    pid: int
    proc: subprocess.Popen
    log: Path

    def alive(self) -> bool:
        return self.proc.poll() is None

    def stop(self) -> None:
        if self.proc.poll() is None:
            self.proc.terminate()
            try:
                self.proc.wait(timeout=5)
            except subprocess.TimeoutExpired:
                self.proc.kill()
                self.proc.wait(timeout=5)


def _wait_ready(port: int, proc: subprocess.Popen, log: Path, timeout: float = 20.0) -> None:
    end = time.time() + timeout
    while time.time() < end:
        try:
            s = socket.create_connection(("127.0.0.1", port), 0.25)
            s.close()
            return
        except OSError:
            if proc.poll() is not None:
                raise RuntimeError(f"relay died on startup: {log.read_text()[-2000:]}")
            time.sleep(0.05)
    raise TimeoutError(f"relay never bound {port}")


def start_python_relay(*, variant: str = "stock", log_dir: Path) -> RelayHandle:
    """variant: 'stock' (python/src on PYTHONPATH) or 'roomindex' (the
    algorithmic-fix prototype tree, spike/relay/pyfix/src) laid ahead of it
    on PYTHONPATH so its agent_presence package shadows the stock one."""
    port = free_port()
    env = dict(os.environ)
    env["AGENT_PRESENCE_PORT"] = str(port)
    env["AGENT_PRESENCE_LOG_LEVEL"] = "WARNING"
    if variant == "roomindex":
        fix_src = ROOT / "spike" / "relay" / "pyfix" / "src"
        env["PYTHONPATH"] = f"{fix_src}:{ROOT / 'python' / 'src'}"
    else:
        env["PYTHONPATH"] = str(ROOT / "python" / "src")
    boot = ROOT / "tests" / "load" / "_relay_boot.py"
    log_dir.mkdir(parents=True, exist_ok=True)
    log = log_dir / f"relay-{variant}-{port}.log"
    fh = open(log, "wb")
    proc = subprocess.Popen([str(VENV_PY), str(boot)], env=env, stdout=fh, stderr=fh)
    _wait_ready(port, proc, log)
    return RelayHandle(f"python-{variant}", f"ws://127.0.0.1:{port}", proc.pid, proc, log)


def start_go_relay(*, log_dir: Path) -> RelayHandle:
    if not GO_RELAY_BIN.exists():
        raise FileNotFoundError(f"build the go prototype first: {GO_RELAY_BIN}")
    port = free_port()
    log_dir.mkdir(parents=True, exist_ok=True)
    log = log_dir / f"relay-go-{port}.log"
    fh = open(log, "wb")
    proc = subprocess.Popen(
        [str(GO_RELAY_BIN), "-addr", f"127.0.0.1:{port}"], stdout=fh, stderr=fh,
    )
    _wait_ready(port, proc, log)
    return RelayHandle("go-prototype", f"ws://127.0.0.1:{port}", proc.pid, proc, log)


async def connect_all(clients: list[Client], batch: int = 25) -> None:
    for i in range(0, len(clients), batch):
        await asyncio.gather(*(c.connect() for c in clients[i:i + batch]))


async def close_all(clients: list[Client]) -> None:
    await asyncio.gather(*(c.close() for c in clients), return_exceptions=True)


async def run_scale(relay: RelayHandle, agents: int, hot: int, rounds: int,
                     hold_ms: float = 3.0) -> dict:
    """One point on the curve: `agents` members in one room, contending over
    `hot` regions, each doing `rounds` claim/release cycles. Same shape as
    tests/load/scenarios.swarm(), generalized over which relay is under test
    and instrumented for client-side CPU so a harness ceiling doesn't get
    misread as a relay ceiling."""
    room = f"scale-{agents}"
    clients = [Client(relay.url, room, f"ag{i:05d}") for i in range(agents)]
    lat = Latency("claim")
    granted = refused = 0
    stalls = 0

    ru0 = resource.getrusage(resource.RUSAGE_SELF)
    t_connect = time.perf_counter()
    await connect_all(clients)
    connect_s = time.perf_counter() - t_connect
    rss_join = rss_kb(relay.pid)
    cpu0 = cpu_seconds(relay.pid)

    async def worker(idx: int, c: Client) -> None:
        nonlocal granted, refused, stalls
        for n in range(rounds):
            path = f"src/hot{(idx + n) % hot}.py"
            try:
                reply, ms = await c.claim(path, intent=f"round {n}")
            except asyncio.TimeoutError:
                stalls += 1
                return
            lat.add(ms)
            if reply.get("granted"):
                granted += 1
                if hold_ms:
                    await asyncio.sleep(hold_ms / 1000.0)
                await c.release(path)
            else:
                refused += 1
                await asyncio.sleep(0.002)

    t0 = time.perf_counter()
    try:
        await asyncio.wait_for(
            asyncio.gather(*(worker(i, c) for i, c in enumerate(clients))),
            timeout=240,
        )
    except asyncio.TimeoutError:
        pass
    elapsed = time.perf_counter() - t0

    rss_peak = rss_kb(relay.pid)
    cpu_used = cpu_seconds(relay.pid) - cpu0
    ru1 = resource.getrusage(resource.RUSAGE_SELF)
    client_cpu = (ru1.ru_utime + ru1.ru_stime) - (ru0.ru_utime + ru0.ru_stime)

    dead = sum(1 for c in clients if c.closed_early)
    errs = sum(len(c.errors) for c in clients)
    frames = sum(sum(c.kinds.values()) for c in clients)

    await close_all(clients)

    ops = len(lat.samples)
    return {
        "relay": relay.name,
        "agents": agents,
        "hot_regions": hot,
        "rounds_each": rounds,
        "connect_s": round(connect_s, 2),
        "ops": ops,
        "elapsed_s": round(elapsed, 2),
        "claims_per_s": round(ops / elapsed, 1) if elapsed else 0,
        "granted": granted,
        "refused": refused,
        "stalls": stalls,
        "relay_alive": relay.alive(),
        "dead_conns": dead,
        "client_errors": errs,
        "frames_delivered": frames,
        "fanout_per_op": round(frames / ops, 1) if ops else 0,
        "claim_latency": lat.row(),
        "relay_cpu_s": round(cpu_used, 3),
        "relay_cpu_ms_per_op": round(cpu_used * 1000 / ops, 4) if ops else 0,
        "relay_rss_kb": {"after_join": rss_join, "peak": rss_peak},
        "relay_rss_kb_per_agent": round((rss_peak - rss_join) / agents, 2) if agents else 0,
        # the harness's own cost. if this rivals relay_cpu_s at the same
        # agent count, the single asyncio client process -- not the relay --
        # is the thing running out of headroom, and the curve above it is
        # not trustworthy without sharding the client across processes.
        "harness_cpu_s": round(client_cpu, 3),
    }


SHARD_WORKER = ROOT / "spike" / "relay" / "bench" / "shard_worker.py"


def run_scale_sharded(relay: RelayHandle, agents: int, hot: int, rounds: int,
                       hold_ms: float, shards: int, tmp: Path) -> dict:
    """Same measurement as run_scale, but the client load is split across
    `shards` OS processes instead of one asyncio loop. See shard_worker.py's
    module docstring for why: past a few hundred connections a single client
    process can peg a core before the relay does, at which point the curve
    is measuring the harness, not the relay."""
    room = f"scale-{agents}"
    per = agents // shards
    counts = [per] * shards
    counts[-1] += agents - per * shards  # remainder to the last shard

    rss_join_placeholder = rss_kb(relay.pid)
    cpu0 = cpu_seconds(relay.pid)
    t0 = time.perf_counter()

    procs = []
    outs = []
    start = 0
    for i, n in enumerate(counts):
        out = tmp / f"shard-{agents}-{i}.json"
        outs.append(out)
        cmd = [str(VENV_PY), str(SHARD_WORKER), "--url", relay.url, "--room", room,
               "--start", str(start), "--count", str(n), "--hot", str(hot),
               "--rounds", str(rounds), "--hold-ms", str(hold_ms), "--out", str(out)]
        procs.append(subprocess.Popen(cmd))
        start += n

    for p in procs:
        rc = p.wait(timeout=260)
        if rc != 0:
            raise RuntimeError(f"shard worker exited {rc}")

    elapsed = time.perf_counter() - t0
    rss_peak = rss_kb(relay.pid)
    cpu_used = cpu_seconds(relay.pid) - cpu0

    lat = Latency("claim")
    granted = refused = stalls = frames = dead = 0
    for out in outs:
        d = json.loads(out.read_text())
        lat.samples.extend(d["samples"])
        granted += d["granted"]; refused += d["refused"]; stalls += d["stalls"]
        frames += d["frames"]; dead += d["dead"]

    ops = len(lat.samples)
    return {
        "relay": relay.name, "agents": agents, "hot_regions": hot,
        "rounds_each": rounds, "shards": shards,
        "ops": ops, "elapsed_s": round(elapsed, 2),
        "claims_per_s": round(ops / elapsed, 1) if elapsed else 0,
        "granted": granted, "refused": refused, "stalls": stalls,
        "relay_alive": relay.alive(), "dead_conns": dead,
        "frames_delivered": frames,
        "fanout_per_op": round(frames / ops, 1) if ops else 0,
        "claim_latency": lat.row(),
        "relay_cpu_s": round(cpu_used, 3),
        "relay_cpu_ms_per_op": round(cpu_used * 1000 / ops, 4) if ops else 0,
        "relay_rss_kb": {"after_join": rss_join_placeholder, "peak": rss_peak},
        "relay_rss_kb_per_agent": round((rss_peak - rss_join_placeholder) / agents, 2) if agents else 0,
    }


def load_average() -> tuple[float, float, float]:
    return os.getloadavg()


async def main_async(args) -> None:
    log_dir = ROOT / "spike" / "relay" / "bench" / ".logs"
    if args.target == "python-stock":
        relay = start_python_relay(variant="stock", log_dir=log_dir)
    elif args.target == "python-roomindex":
        relay = start_python_relay(variant="roomindex", log_dir=log_dir)
    elif args.target == "go":
        relay = start_go_relay(log_dir=log_dir)
    else:
        raise ValueError(args.target)

    results = []
    tmp = log_dir / "shards"
    tmp.mkdir(parents=True, exist_ok=True)
    try:
        for agents in args.scale:
            la_before = load_average()
            if args.shards > 1:
                row = run_scale_sharded(relay, agents, args.hot, args.rounds,
                                         args.hold_ms, args.shards, tmp)
            else:
                row = await run_scale(relay, agents, args.hot, args.rounds, args.hold_ms)
            la_after = load_average()
            row["loadavg_before"] = la_before
            row["loadavg_after"] = la_after
            results.append(row)
            print(json.dumps(row))
            await asyncio.sleep(1.0)  # let the relay settle between points
    finally:
        relay.stop()

    if args.json:
        Path(args.json).write_text(json.dumps(results, indent=2))


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--target", choices=["python-stock", "python-roomindex", "go"],
                     default="python-stock")
    ap.add_argument("--scale", type=int, nargs="+", default=[200, 400, 800, 1600])
    ap.add_argument("--hot", type=int, default=8)
    ap.add_argument("--rounds", type=int, default=15)
    ap.add_argument("--hold-ms", type=float, default=3.0)
    ap.add_argument("--shards", type=int, default=1,
                     help="split client load across N OS processes")
    ap.add_argument("--json", default=None)
    args = ap.parse_args()
    asyncio.run(main_async(args))


if __name__ == "__main__":
    main()
