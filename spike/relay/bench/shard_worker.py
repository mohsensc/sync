"""One shard of load-generating clients, in its own OS process.

Methodology note (see docs/relay-spike.md, "attacking the methodology"): a
single asyncio process generating 1600 websocket clients turned out to be
the actual bottleneck once the relay under test got fast enough (the Go
prototype) -- the client process pegged a core while the relay had
cores to spare. Splitting the client across N processes, each with its own
asyncio loop and its own core, removes that ceiling and is also closer to
reality: real daemons are N separate OS processes, not one.
"""
from __future__ import annotations

import asyncio
import json
import os
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(ROOT / "tests" / "load"))
from _lib import Client, Latency  # noqa: E402


async def run(url: str, room: str, start: int, count: int, hot: int, rounds: int,
              hold_ms: float) -> dict:
    clients = [Client(url, room, f"ag{start + i:05d}") for i in range(count)]
    lat = Latency("claim")
    granted = refused = stalls = 0

    for i in range(0, len(clients), 25):
        await asyncio.gather(*(c.connect() for c in clients[i:i + 25]))

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

    await asyncio.wait_for(
        asyncio.gather(*(worker(start + i, c) for i, c in enumerate(clients))),
        timeout=240,
    )
    await asyncio.gather(*(c.close() for c in clients), return_exceptions=True)
    return {
        "samples": lat.samples, "granted": granted, "refused": refused,
        "stalls": stalls,
        "frames": sum(sum(c.kinds.values()) for c in clients),
        "dead": sum(1 for c in clients if c.closed_early),
    }


def main() -> None:
    import argparse
    ap = argparse.ArgumentParser()
    ap.add_argument("--url", required=True)
    ap.add_argument("--room", required=True)
    ap.add_argument("--start", type=int, required=True)
    ap.add_argument("--count", type=int, required=True)
    ap.add_argument("--hot", type=int, required=True)
    ap.add_argument("--rounds", type=int, required=True)
    ap.add_argument("--hold-ms", type=float, default=3.0)
    ap.add_argument("--out", required=True)
    args = ap.parse_args()
    result = asyncio.run(run(args.url, args.room, args.start, args.count,
                              args.hot, args.rounds, args.hold_ms))
    Path(args.out).write_text(json.dumps(result))


if __name__ == "__main__":
    main()
