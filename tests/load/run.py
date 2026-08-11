#!/usr/bin/env python3
"""Load and chaos harness for agent-presence.

    python tests/load/run.py --all
    python tests/load/run.py swarm --agents 200 --rounds 20
    python tests/load/run.py --list

Every knob has a default that finishes in a few minutes on a laptop. --all runs
the lot serially, because several scenarios measure latency against a real
socket and running them together would measure the machine instead.
"""

from __future__ import annotations

import argparse
import asyncio
import json
import subprocess
import sys
import time
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))

from _lib import AP_HOOK, PRESENCED, ROOT  # noqa: E402
import scenarios as S  # noqa: E402

HOOKBENCH_SRC = HERE / "hookbench.cpp"
HOOKBENCH = HERE / "build" / "hookbench"


def build_hookbench() -> None:
    """The hook's socket phase, compiled against the real hook.cpp.

    Its own compile rather than a cmake target: cpp/CMakeLists.txt belongs to
    the product and a harness has no business editing it.
    """
    HOOKBENCH.parent.mkdir(parents=True, exist_ok=True)
    # Against every source it is built from, not just its own. It links the
    # product's hook.cpp, and a run that quietly measured last week's copy of
    # that is a run that says nothing about the daemon in front of it.
    sources = [HOOKBENCH_SRC, ROOT / "cpp" / "hook" / "hook.cpp",
               ROOT / "cpp" / "hook" / "hook.hpp", ROOT / "cpp" / "hook" / "protocol.hpp"]
    newest = max(p.stat().st_mtime for p in sources if p.exists())
    if HOOKBENCH.exists() and HOOKBENCH.stat().st_mtime > newest:
        return
    subprocess.run(
        ["c++", "-std=c++20", "-O2", "-I", str(ROOT / "cpp"), str(HOOKBENCH_SRC),
         str(ROOT / "cpp" / "hook" / "hook.cpp"), "-o", str(HOOKBENCH)],
        check=True,
    )


def build_presenced() -> None:
    """The Go daemon (#18). `go build` is fast enough to just always run it
    rather than track staleness by hand the way build_hookbench does for a
    C++ compile — `go build` already does its own up-to-date check."""
    PRESENCED.parent.mkdir(parents=True, exist_ok=True)
    subprocess.run(
        ["go", "build", "-o", str(PRESENCED), "./cmd/presenced"],
        cwd=str(ROOT / "go"), check=True,
    )


def preflight() -> None:
    if not AP_HOOK.exists():
        raise SystemExit(
            "build the hook first:\n"
            "  cmake -S cpp -B cpp/build && cmake --build cpp/build\n"
            f"missing: {AP_HOOK}")
    build_presenced()
    build_hookbench()
    subprocess.run("lsof -ti:8799 | xargs kill -9", shell=True,
                   capture_output=True)


SCENARIOS = {
    "swarm50": lambda a: S.swarm(a.agents, a.hot, a.rounds),
    "swarm200": lambda a: S.swarm(a.agents_large, a.hot, a.rounds),
    "rooms": lambda a: S.rooms(a.rooms, a.per_room, a.rounds),
    "relay-restart": lambda a: S.relay_restart(a.daemons),
    "daemon-kill": lambda a: S.daemon_kill(a.hook_threads, a.hook_iters),
    "flood": lambda a: S.flood(a.events, a.flood_threads),
    "slow-subscriber": lambda a: S.slow_subscriber(a.busy_agents, a.window_s),
    "hook-latency": lambda a: S.hook_latency(a.holders, a.leases_each,
                                             a.hook_threads, a.hook_iters,
                                             a.storm_lanes),
    "lease-churn": lambda a: S.lease_churn(a.churn_agents, a.ttl_s, a.window_s),
    "lease-takeover": lambda a: S.lease_takeover(),
}

ORDER = ["swarm50", "swarm200", "rooms", "relay-restart", "daemon-kill",
         "flood", "slow-subscriber", "hook-latency", "lease-churn",
         "lease-takeover"]


def parse_args(argv: list[str]) -> argparse.Namespace:
    p = argparse.ArgumentParser(prog="run.py", description=__doc__,
                                formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("scenario", nargs="*", default=[],
                   help=f"one or more of: {', '.join(ORDER)}")
    p.add_argument("--all", action="store_true", help="run every scenario")
    p.add_argument("--list", action="store_true")
    p.add_argument("--json", type=Path, help="write the full result set here")

    g = p.add_argument_group("swarm")
    g.add_argument("--agents", type=int, default=50, help="swarm50 agent count")
    g.add_argument("--agents-large", type=int, default=200,
                   help="swarm200 agent count")
    g.add_argument("--hot", type=int, default=5, help="hot regions they collide on")
    g.add_argument("--rounds", type=int, default=12, help="claims per agent")

    g = p.add_argument_group("rooms")
    g.add_argument("--rooms", type=int, default=20)
    g.add_argument("--per-room", type=int, default=8)

    g = p.add_argument_group("chaos")
    g.add_argument("--daemons", type=int, default=6)
    g.add_argument("--events", type=int, default=8000)
    g.add_argument("--flood-threads", type=int, default=4)

    g = p.add_argument_group("hooks")
    g.add_argument("--hook-threads", type=int, default=8)
    g.add_argument("--hook-iters", type=int, default=3000)
    g.add_argument("--holders", type=int, default=40)
    g.add_argument("--leases-each", type=int, default=25)
    g.add_argument("--storm-lanes", type=int, default=6,
                   help="threads flooding the daemon socket with events while "
                        "the decision hooks are being measured")

    g = p.add_argument_group("slow subscriber / churn")
    g.add_argument("--busy-agents", type=int, default=25)
    g.add_argument("--window-s", type=float, default=10.0)
    g.add_argument("--churn-agents", type=int, default=40)
    g.add_argument("--ttl-s", type=float, default=3.0)

    return p.parse_args(argv)


def print_result(res: S.Result) -> None:
    mark = "ok  " if res.ok else "FAIL"
    print(f"\n[{mark}] {res.name}")
    print(json.dumps(res.metrics, indent=2, default=str))
    for f in res.findings:
        print(f"  ! {f}")


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv or sys.argv[1:])
    if args.list:
        for name in ORDER:
            print(name)
        return 0

    names = args.scenario or (ORDER if args.all else [])
    unknown = [n for n in names if n not in SCENARIOS]
    if unknown:
        raise SystemExit(f"unknown scenario {unknown}; --list shows them all")
    if not names:
        print("nothing to run; pass --all or a scenario name (--list to see them)")
        return 2

    preflight()
    results: list[S.Result] = []
    for name in names:
        print(f"\n=== {name} ===", flush=True)
        t0 = time.perf_counter()
        try:
            res = asyncio.run(SCENARIOS[name](args))
        except Exception as exc:
            res = S.Result(name)
            res.bad(f"HARNESS OR PRODUCT CRASH: {type(exc).__name__}: {exc}")
        res.metrics["scenario_wall_s"] = round(time.perf_counter() - t0, 1)
        results.append(res)
        print_result(res)

    print("\n" + "=" * 72)
    print("SUMMARY")
    print("=" * 72)
    failures = 0
    for res in results:
        mark = "ok  " if res.ok else "FAIL"
        print(f"  [{mark}] {res.name:28s} {res.metrics.get('scenario_wall_s', 0)}s")
        for f in res.findings:
            failures += 1
            print(f"           ! {f}")
    print(f"\n{len(results)} scenarios, {failures} findings")
    if failures == 0:
        print("A harness that finds nothing is a suspect harness. Check that the "
              "relay and daemon really came up before believing this.")

    if args.json:
        args.json.write_text(json.dumps(
            [{"name": r.name, "ok": r.ok, "metrics": r.metrics,
              "findings": r.findings} for r in results], indent=2, default=str))
    return 1 if failures else 0


if __name__ == "__main__":
    raise SystemExit(main())
