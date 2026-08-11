"""Time redundant_peer's peer loop at a few room sizes.

    ./.venv/bin/python tools/bench_redundant_peer.py

Backs the numbers in similarity.py's comment on `_tokens_cached` and in
docs/languages.md's `similarity.py` row. Each rep uses a fresh incoming
intent and a cleared token cache, so this measures the realistic case - a
new declaration arriving, not the same one scored twice - not the
best-case with a fully warm cache.
"""

from __future__ import annotations

import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "tests"))

import os

os.environ["AGENT_PRESENCE_RUNG4"] = "1"

from agent_presence.ladder import Activity, redundant_peer  # noqa: E402
from agent_presence.similarity import LexicalSimilarity, _tokens_cached  # noqa: E402
from agent_presence.types import AgentEvent, Region  # noqa: E402

REPS = 800


def peers(n: int) -> list[Activity]:
    return [
        Activity(agent=f"a{i}", human="h", verb="edit",
                 region=Region(path=f"src/f{i}.py", symbol=None, lines=None),
                 intent=f"work on module {i} for the thing", source="mcp")
        for i in range(n)
    ]


def main() -> int:
    sim = LexicalSimilarity()
    print(f"{'peers':>6}  {'ms/call (cold cache)':>22}")
    for n in (5, 50, 200):
        ps = peers(n)
        t0 = time.perf_counter()
        for r in range(REPS):
            _tokens_cached.cache_clear()
            intent = f"add retry with backoff to the S3 uploader, variant {r}"
            event = AgentEvent(room="r1", human="dev", agent="incoming",
                                kind="claim", source="mcp", verb="edit",
                                region=Region(path="src/new.py", symbol=None,
                                              lines=None), ts=1.0)
            redundant_peer(event, ps, intent, sim)
        dt_ms = (time.perf_counter() - t0) / REPS * 1000
        print(f"{n:>6}  {dt_ms:>22.4f}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
