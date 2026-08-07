from __future__ import annotations

import random
from dataclasses import dataclass

from agent_presence.clock import VirtualClock
from agent_presence.leases import LEASE_TTL_S, LeaseRegistry
from agent_presence.types import Region
from agent_presence.wound_wait import resolve


@dataclass(frozen=True)
class SimResult:
    granted: int
    aborted: int
    waits: int
    live_at_end: int


class Simulation:
    """Virtual-clock simulation of N agents contending over M regions.

    Fully deterministic for a given seed, so a failing case reproduces exactly.
    """

    def __init__(self, seed: int, agents: int, regions: int) -> None:
        self._rand = random.Random(seed)
        self._clock = VirtualClock()
        self._registry = LeaseRegistry(self._clock)
        self._agents = [f"a{i}" for i in range(agents)]
        self._regions = [
            Region(path=f"src/f{i}.py", symbol=f"sym{i}", lines=None)
            for i in range(regions)
        ]
        # Oldest live claim time per agent, which is what wound-wait orders on.
        self._age: dict[str, float] = {}

    def run(self, steps: int) -> SimResult:
        granted = aborted = waits = 0

        for _ in range(steps):
            agent = self._rand.choice(self._agents)
            region = self._rand.choice(self._regions)
            roll = self._rand.random()

            if roll < 0.65:
                result = self._registry.acquire("r1", agent, agent, region, "work")
                if result.ok:
                    granted += 1
                    self._age.setdefault(agent, self._clock.now())
                else:
                    decision = resolve(
                        agent, self._age.get(agent, self._clock.now()), result.held_by
                    )
                    if decision == "abort":
                        aborted += 1
                        # Aborting releases everything the agent holds. That is
                        # what guarantees the wait-for graph cannot keep a cycle.
                        self._registry.release_all(agent)
                        self._age.pop(agent, None)
                    else:
                        waits += 1
            elif roll < 0.85:
                self._registry.release(agent, region)
                if all(c.agent != agent for c in self._registry.active_claims("r1")):
                    self._age.pop(agent, None)
            else:
                self._clock.advance(1.0)

        # Drain: advance past the TTL with no heartbeats. Nothing may survive.
        self._clock.advance(LEASE_TTL_S + 1)
        return SimResult(
            granted=granted,
            aborted=aborted,
            waits=waits,
            live_at_end=len(self._registry.active_claims("r1")),
        )
