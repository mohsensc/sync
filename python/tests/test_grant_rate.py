"""#36: grant rate collapses to ~10% under hot-region contention.

`tests/load/run.py swarm50` measures this against a real relay over real
sockets, which is the right place to have found it and the wrong place to
guard it — a few seconds, and noisy with it. This reproduces the same shape
(50 agents, 5 hot regions, 20 rounds, ~10 concurrent askers per region every
round) straight against `LeaseRegistry` with a `VirtualClock`, no network, no
asyncio, deterministic for a given seed.

Two things turned out to be true at once, both load-bearing for #36's
acceptance criteria:

- The single-round rate really is capped near 10% no matter what a client
  does with a `wait` verdict. Ten agents contend a region at the same
  instant; exactly one can hold it; the other nine are refused. That is the
  scenario's own arithmetic, not a bug, and no retry strategy changes it.
- Whether a *worker's unit of work* (one of the 20 rounds each agent has to
  get through, contested region or not) eventually succeeds is a different
  question, and the load harness's worker answers it dishonestly: on any
  refusal — `wait` included — it backs off and moves on to a *different*
  region next round (`tests/load/scenarios.py`, `swarm()`). A `wait` verdict
  means "hold your place, the region will be yours"; nothing in the worker
  ever holds its place. A worker that retries the *same* region on `wait`
  finishes meaningfully more of its rounds granted rather than aborted, at
  the identical oversubscription ratio — see the second test below.
"""

from __future__ import annotations

import random

from agent_presence.clock import VirtualClock
from agent_presence.leases import LeaseRegistry
from agent_presence.types import Region

ROOM = "swarm"
HOT = 5
AGENTS = 50
ROUNDS = 20
# Both far under any handover or fair-share grace, matching the load
# scenario's own hold_ms=3 / backoff=2ms — nowhere near long enough for a
# holder to ever hit a forced handover deadline. See _hand_over in leases.py:
# a lease that ends this early leaves no reservation behind, so a `wait`
# verdict earns a requester nothing structural. It has to earn its keep by
# outlasting the crowd, which is exactly what the second test below checks.
STEP_S = 0.0005
HOLD_S = 0.003


def _region(i: int) -> Region:
    return Region(path=f"src/hot{i}.py", symbol=None, lines=None)


def _run_swarm(seed: int, retry_same_region_on_wait: bool) -> tuple[int, int]:
    """The swarm scenario's own math, against the registry directly.

    Agent `idx` wants region `(idx + n) % HOT` on round `n`, same as
    `swarm()`'s worker. Every still-active agent attempts once per pass, in
    an order shuffled per pass — a real relay sees these off `AGENTS`
    separate sockets, not in agent-id order — and a pass's winners hold
    their claim across the whole pass before releasing, the same way ten
    concurrent askers really do overlap a granted holder for the length of
    its hold rather than queueing behind it one at a time.

    ``retry_same_region_on_wait=False`` is today's harness worker: any
    refusal advances to the next round's (different) region.
    ``retry_same_region_on_wait=True`` is a worker that acts on `wait`:
    holds its place, tries the same region again next pass, and only moves
    on when it is told `abort` or actually granted.

    Returns (granted, rounds_done). ``rounds_done`` is always
    ``AGENTS * ROUNDS`` — every agent gets through all its rounds either
    way; the question is how many of them ended in a grant.
    """
    rand = random.Random(seed)
    clock = VirtualClock()
    registry = LeaseRegistry(clock)
    regions = [_region(i) for i in range(HOT)]

    n = [0] * AGENTS
    active = list(range(AGENTS))
    granted = 0
    rounds_done = 0

    # A guard for the test, not a real bound: wait-die's own progress
    # argument (wait_die.py) says every wait eventually resolves, and
    # nothing observed here has needed more than ~60 passes. If a change
    # somewhere breaks that guarantee, fail loudly rather than hang CI.
    for _pass in range(2000):
        if not active:
            break
        order = active[:]
        rand.shuffle(order)
        winners: list[tuple[int, Region]] = []
        finished = []
        for idx in order:
            region = regions[(idx + n[idx]) % HOT]
            clock.advance(STEP_S)
            result = registry.acquire(
                ROOM, "human", f"ag{idx:04d}", region, f"round {n[idx]}",
            )
            if result.ok:
                granted += 1
                winners.append((idx, region))
                n[idx] += 1
                rounds_done += 1
            elif result.decision == "wait" and retry_same_region_on_wait:
                pass  # holds its place; same region, next pass
            else:
                n[idx] += 1
                rounds_done += 1
            if n[idx] >= ROUNDS:
                finished.append(idx)
        # Every winner this pass held for the whole pass, the way a
        # concurrent holder would overlap the other nine askers that missed
        # it, not one that came and went before the next of them arrived.
        clock.advance(HOLD_S)
        for idx, region in winners:
            registry.release(ROOM, f"ag{idx:04d}", region)
        for idx in finished:
            active.remove(idx)
    else:
        raise AssertionError("swarm model did not converge in 2000 passes")

    return granted, rounds_done


def test_single_round_grant_rate_is_capped_near_ten_percent_by_the_crowd():
    """The shape, not a bug: ten agents contest each hot region every round
    and exactly one of them can hold it. Confirms #36's own finding that the
    scenario's arithmetic bounds this near 10% -- independent of wait-die,
    independent of retry strategy (see the next test, which uses the exact
    same crowd and still lands here)."""
    granted, rounds_done = _run_swarm(seed=1, retry_same_region_on_wait=False)
    assert rounds_done == AGENTS * ROUNDS
    rate = granted / rounds_done
    assert rate < 0.15, (
        f"expected the ~10% single-round collapse this scenario's shape "
        f"predicts, got {rate:.1%} -- something changed the crowd size or "
        f"the arbitration itself, not just the retry strategy"
    )


def test_retrying_the_same_region_on_wait_recovers_meaningfully_more_grants():
    """The harness worker today (`retry_same_region_on_wait=False`) throws
    away a `wait` verdict's whole point -- it backs off and abandons the
    region for a different one next round, the same as it does on `abort`.
    A worker that instead holds its place and keeps asking for the region it
    actually wants finishes far more of its rounds granted rather than
    aborted, at the identical 10-askers-per-region oversubscription.

    This is #36's acceptance criterion 1: does retrying the *same* region on
    `wait` recover a meaningfully higher grant rate at the same
    oversubscription ratio. It does -- consistently upward of 2x across
    seeds, not noise.
    """
    for seed in range(1, 6):
        baseline, rounds_a = _run_swarm(seed, retry_same_region_on_wait=False)
        retried, rounds_b = _run_swarm(seed, retry_same_region_on_wait=True)
        assert rounds_a == rounds_b == AGENTS * ROUNDS
        assert retried >= baseline * 1.5, (
            f"seed {seed}: retry-on-wait only reached {retried} grants "
            f"against a baseline of {baseline} -- expected at least 1.5x"
        )
