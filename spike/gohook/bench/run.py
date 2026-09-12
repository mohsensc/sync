#!/usr/bin/env python3
"""Head-to-head p99 for the Go hook spike vs the real C++ ap-hook.

Answers issue #23: can a Go build of the hot path (read stdin, extract
fields, unix-socket round trip, print decision JSON, exit) meet the 5ms
budget once fork+exec is counted, not just the in-process socket phase
hookbench.cpp measures.

Every timed call is a real subprocess: fork, exec, the binary's own
runtime init, the socket round trip, exit, reap. That is what a Claude
Code tool call actually pays. Idle and 16-storm-lane runs alternate one
call at a time (cpp, go, cpp, go, ...) so thermal drift and background
noise land on both languages equally rather than favoring whichever
runs first or second.

Usage:
    presenced already built:      cmake -S cpp -B cpp/build && cmake --build cpp/build
    go hook already built:        cd spike/gohook && go build -o gohook .
    python3 spike/gohook/bench/run.py [--iters 1000] [--storm-lanes 16] [--json out.json]
"""
from __future__ import annotations

import argparse
import json
import os
import platform
import socket
import statistics
import subprocess
import sys
import tempfile
import threading
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]  # .../sync-gohook
CPP_HOOK = ROOT / "cpp" / "build" / "ap-hook"
PRESENCED = ROOT / "cpp" / "build" / "presenced"
GO_HOOK = ROOT / "spike" / "gohook" / "gohook"


def payload(path: str, session: str) -> bytes:
    return (
        '{"hook_event_name":"PreToolUse","tool_name":"Edit","tool_input":'
        f'{{"file_path":"{path}"}},"file_path":"{path}","session_id":"{session}"}}'
    ).encode()


def event_line(lane: int, i: int) -> bytes:
    return (
        f'{{"verb":"search","agent":"storm{lane}","path":"src/storm/{lane}/{i}.py"}}\n'
    ).encode()


class Daemon:
    """A real presenced, standalone: no relay reachable, empty lease cache.

    Every request still gets a real rung-0 answer (daemon/decide.cpp always
    responds, contested or not) — this is the same "idle" shape
    tests/load/scenarios.py's hook_latency benches against before any leases
    are populated, not a stub.
    """

    def __init__(self) -> None:
        self.dir = Path(tempfile.mkdtemp(prefix="ap-gohook-bench-"))
        self.sock = self.dir / "d.sock"
        self.proc: subprocess.Popen | None = None

    def start(self) -> None:
        env = dict(os.environ)
        env["AGENT_SYNC_SOCK"] = str(self.sock)
        env["AGENT_SYNC_SNAPSHOT"] = str(self.dir / "d.json")
        env["AGENT_SYNC_JOURNAL"] = str(self.dir / "d.jsonl")
        # Unroutable: the daemon's relay client fails to connect and keeps
        # retrying off the hot path, same as a laptop with no relay running.
        env["AGENT_SYNC_RELAY"] = "ws://127.0.0.1:1"
        self.proc = subprocess.Popen(
            [str(PRESENCED)], env=env, cwd=self.dir,
            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
        )
        deadline = time.time() + 5
        decide_sock = Path(str(self.sock) + ".decide")
        while time.time() < deadline:
            if self.sock.exists() and decide_sock.exists():
                return
            time.sleep(0.02)
        raise RuntimeError("presenced never created its sockets")

    def stop(self) -> None:
        if self.proc is not None:
            self.proc.terminate()
            try:
                self.proc.wait(timeout=5)
            except subprocess.TimeoutExpired:
                self.proc.kill()


def run_hook_once(binary: Path, sock: Path, path: str, session: str) -> float:
    env = dict(os.environ)
    env["AGENT_SYNC_SOCK"] = str(sock)
    t0 = time.perf_counter()
    subprocess.run(
        [str(binary)], input=payload(path, session), env=env,
        stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=5,
    )
    t1 = time.perf_counter()
    return (t1 - t0) * 1000.0


def warm(binary: Path, sock: Path) -> None:
    for i in range(20):
        run_hook_once(binary, sock, f"/repo/src/hot{i % 8}.py", "warm")


def interleaved_run(sock: Path, iters: int, label: str) -> dict:
    cpp_samples: list[float] = []
    go_samples: list[float] = []
    for i in range(iters):
        path = f"/repo/src/hot{i % 8}.py"
        cpp_samples.append(run_hook_once(CPP_HOOK, sock, path, f"cpp-{i}"))
        go_samples.append(run_hook_once(GO_HOOK, sock, path, f"go-{i}"))
        if (i + 1) % 200 == 0:
            print(f"  [{label}] {i + 1}/{iters}", file=sys.stderr)
    return {"cpp": cpp_samples, "go": go_samples}


def stats(samples: list[float]) -> dict:
    s = sorted(samples)
    n = len(s)

    def pct(q: float) -> float:
        idx = min(n - 1, int(n * q))
        return s[idx]

    return {
        "n": n,
        "p50_ms": round(pct(0.50), 4),
        "p95_ms": round(pct(0.95), 4),
        "p99_ms": round(pct(0.99), 4),
        "max_ms": round(s[-1], 4),
        "over_5ms": sum(1 for v in s if v > 5.0),
    }


def start_storm(sock: Path, lanes: int) -> threading.Event:
    stop = threading.Event()

    def lane_loop(lane: int) -> None:
        i = 0
        while not stop.is_set():
            try:
                s = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
                s.settimeout(2.0)
                s.connect(str(sock))
                s.sendall(event_line(lane, i))
                s.close()
            except OSError:
                pass
            i += 1

    for lane in range(lanes):
        threading.Thread(target=lane_loop, args=(lane,), daemon=True).start()
    return stop


def machine_info() -> dict:
    info = {"platform": platform.platform(), "python": platform.python_version()}
    if sys.platform == "darwin":
        try:
            info["cpu"] = subprocess.check_output(
                ["sysctl", "-n", "machdep.cpu.brand_string"], text=True
            ).strip()
        except Exception:
            pass
    return info


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--iters", type=int, default=1000)
    ap.add_argument("--storm-lanes", type=int, default=16)
    ap.add_argument("--json", type=Path, default=None)
    ap.add_argument("--raw", type=Path, default=None,
                     help="also dump raw per-call sample arrays (for paired-delta analysis)")
    args = ap.parse_args()

    for b in (CPP_HOOK, PRESENCED, GO_HOOK):
        if not b.exists():
            print(f"missing {b} — build it first", file=sys.stderr)
            return 2

    daemon = Daemon()
    daemon.start()
    try:
        print("warming up...", file=sys.stderr)
        warm(CPP_HOOK, daemon.sock)
        warm(GO_HOOK, daemon.sock)

        print(f"idle: {args.iters} interleaved calls per hook...", file=sys.stderr)
        idle = interleaved_run(daemon.sock, args.iters, "idle")

        print(f"storm: {args.storm_lanes} lanes hammering the event socket...",
              file=sys.stderr)
        stop = start_storm(daemon.sock, args.storm_lanes)
        time.sleep(0.3)  # let the lanes actually saturate before timing starts
        try:
            storm = interleaved_run(daemon.sock, args.iters, "storm16")
        finally:
            stop.set()

        result = {
            "conditions": {
                "idle": {"cpp": stats(idle["cpp"]), "go": stats(idle["go"])},
                f"storm{args.storm_lanes}": {
                    "cpp": stats(storm["cpp"]), "go": stats(storm["go"])
                },
            },
            "iters_per_hook_per_condition": args.iters,
            "storm_lanes": args.storm_lanes,
            "machine": machine_info(),
            "timestamp": time.strftime("%Y-%m-%d %H:%M:%S %z"),
        }
    finally:
        daemon.stop()

    print(json.dumps(result, indent=2))
    if args.json:
        args.json.write_text(json.dumps(result, indent=2))
    if args.raw:
        args.raw.write_text(json.dumps({
            "idle": idle,
            f"storm{args.storm_lanes}": storm,
        }))

    for cond, langs in result["conditions"].items():
        for lang, s in langs.items():
            print(f"{cond:>10} {lang:>4}: p50={s['p50_ms']:.3f}ms p95={s['p95_ms']:.3f}ms "
                  f"p99={s['p99_ms']:.3f}ms max={s['max_ms']:.3f}ms over5ms={s['over_5ms']}",
                  file=sys.stderr)

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
