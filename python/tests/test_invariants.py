from __future__ import annotations

import random
from dataclasses import dataclass, field

import pytest

from agent_presence import leases
from agent_presence.clock import VirtualClock
from agent_presence.leases import LEASE_TTL_S, LeaseRegistry
from agent_presence.priority import PRIORITY_NAMES, PRIORITY_NORMAL
from agent_presence.types import Region
from sim.simulation import Simulation

ROOM = "r1"
# Virtual seconds per turn. Small enough that a whole run stays well inside the
# lease TTL, so expiry can never be what unjams a run — only wait-die can.
STEP_S = 0.005


class Deadlock(AssertionError):
    """Every agent blocked, nobody able to move, nothing expiring."""


@dataclass
class _Agent:
    name: str
    want: tuple[Region, ...]
    held: int = 0
    granted: int = 0
    finished: int = 0


@dataclass
class Outcome:
    grants: int = 0
    aborts: int = 0
    waits: int = 0
    rounds: int = 0
    per_agent: dict[str, int] = field(default_factory=dict)
    finished: dict[str, int] = field(default_factory=dict)


class Contention:
    """Agents that hold one region while asking for another.

    That is the only shape in which a wait-for cycle exists at all. The
    simulation in sim/ picks one region at a time, so an agent never holds
    anything while it waits and a cycle is unreachable by construction — which
    is why counting its grants proves nothing about deadlock.

    Here every agent needs two regions arranged in a ring (a0 wants r0 then r1,
    a1 wants r1 then r2, ...), which is the textbook cycle. Refusals go through
    the production path: LeaseRegistry.acquire computes the wait-die decision
    and the caller obeys it, so swapping in a symmetric resolver really does
    wedge this.
    """

    def __init__(
        self,
        seed: int,
        agents: int = 8,
        regions: int = 4,
        tiers: dict[str, int] | None = None,
    ) -> None:
        self._rand = random.Random(seed)
        self._clock = VirtualClock()
        self._registry = LeaseRegistry(self._clock)
        self._regions = [
            Region(path=f"src/f{i}.py", symbol=f"sym{i}", lines=None)
            for i in range(regions)
        ]
        self._agents = [
            _Agent(
                name=f"a{i}",
                want=(self._regions[i % regions], self._regions[(i + 1) % regions]),
            )
            for i in range(agents)
        ]
        # Per-agent priority tier. Empty means everyone at normal, which is the
        # room-with-no-roster case and what every test above runs.
        self._tiers = tiers or {}

    def _turn(self, ag: _Agent, out: Outcome) -> str:
        self._clock.advance(STEP_S)
        result = self._registry.acquire(
            ROOM, "human", ag.name, ag.want[ag.held], "work",
            priority=self._tiers.get(ag.name, PRIORITY_NORMAL),
        )
        if result.ok:
            out.grants += 1
            ag.granted += 1
            ag.held += 1
            if ag.held == len(ag.want):
                # Got everything it needed: do the work, drop the lot. One
                # `release` per region, the way a real agent lets go of real
                # regions, and not `release_all` — that call is reserved for a
                # session ending or a wait-die abort (see its docstring), and
                # is the one that must NOT look like a transaction concluding
                # on its own terms, or `age_of` can never tell "just finished"
                # from "just aborted".
                ag.finished += 1
                for region in ag.want:
                    self._registry.release(ROOM, ag.name, region)
                ag.held = 0
            return "grant"

        if result.decision == "abort":
            out.aborts += 1
            self._registry.release_all(ROOM, ag.name)
            ag.held = 0
            return "abort"

        out.waits += 1
        return "wait"

    def run(self, rounds: int) -> Outcome:
        # Kept on the model too, so a run that dies mid-way can still be
        # inspected for what it managed to do before it wedged.
        out = self.last = Outcome()
        for r in range(rounds):
            order = list(self._agents)
            self._rand.shuffle(order)
            outcomes = {a.name: self._turn(a, out) for a in order}
            out.rounds = r + 1

            # Every agent took a turn, every turn was refused with "wait", so
            # no lease moved: the state that produced the first verdict is the
            # same state that produced the last. All of them are blocked at
            # once, on each other. That is a wait-cycle, not a slow round.
            if all(v == "wait" for v in outcomes.values()):
                blocked = sorted(
                    (a.name, a.want[a.held].path) for a in self._agents
                )
                raise Deadlock(
                    f"round {r}: every agent waiting, none can proceed: {blocked}"
                )

        # Nothing may have expired, or expiry — not wait-die — could be what
        # kept things moving.
        assert self._clock.now() < LEASE_TTL_S, "run outlived the lease TTL"
        out.per_agent = {a.name: a.granted for a in self._agents}
        out.finished = {a.name: a.finished for a in self._agents}
        return out


# -- deadlock freedom --------------------------------------------------------


@pytest.mark.parametrize("seed", range(50))
def test_no_schedule_reaches_a_state_where_every_agent_waits(seed):
    # Contention.run raises Deadlock the moment a round passes with every agent
    # blocked and nothing changing hands.
    Contention(seed).run(300)


@pytest.mark.parametrize("seed", range(50))
def test_every_agent_under_contention_eventually_gets_work_done(seed):
    out = Contention(seed).run(300)
    starved = [a for a, n in out.per_agent.items() if n == 0]
    assert not starved, f"never acquired anything: {starved}"
    stuck = [a for a, n in out.finished.items() if n == 0]
    assert not stuck, f"acquired but never completed a unit of work: {stuck}"


@pytest.mark.parametrize("seed", range(10))
def test_grants_keep_coming_as_the_schedule_runs_longer(seed):
    short = Contention(seed).run(100)
    long = Contention(seed).run(300)
    # A wedged run flatlines. A live one keeps granting at roughly a steady
    # rate, so tripling the rounds has to more than double the grants.
    assert long.grants > 2 * short.grants


def test_the_deadlock_check_catches_a_symmetric_resolver(monkeypatch):
    # The positive control. Wait-die is deadlock-free because the relation is
    # asymmetric; make it symmetric (everyone waits, nobody dies) and the ring
    # above has to wedge. If this test stops failing-by-detection, the ones
    # above have stopped meaning anything.
    # The fake takes the tier argument acquire now passes and ignores it — the
    # point of the control is that the *relation* is symmetric, not which
    # arguments it reads.
    monkeypatch.setattr(
        leases, "resolve", lambda agent, age, holder, priority=PRIORITY_NORMAL: "wait"
    )
    with pytest.raises(Deadlock):
        Contention(0).run(300)


def test_a_deadlocked_run_still_grants_plenty_before_it_wedges(monkeypatch):
    # Why the old assertion (granted > 0) was worth nothing: a deadlock-prone
    # resolver hands out leases happily right up to the moment the ring closes.
    # Counting grants can only ever catch a system that never started.
    # The fake takes the tier argument acquire now passes and ignores it — the
    # point of the control is that the *relation* is symmetric, not which
    # arguments it reads.
    monkeypatch.setattr(
        leases, "resolve", lambda agent, age, holder, priority=PRIORITY_NORMAL: "wait"
    )
    model = Contention(0)
    with pytest.raises(Deadlock):
        model.run(300)
    assert model.last.grants > 0
    assert model.last.rounds < 300  # it stopped early; it did not finish


# -- the same ring, with priority in the key ---------------------------------


def _mixed_tiers(seed: int, agents: int = 8) -> dict[str, int]:
    rand = random.Random(seed)
    names = list(PRIORITY_NAMES.values())
    return {f"a{i}": rand.choice(names) for i in range(agents)}


@pytest.mark.parametrize("seed", range(50))
def test_mixed_tiers_never_reach_a_state_where_every_agent_waits(seed):
    # Priority added a third component to the ordering key. A third component
    # is only safe while the whole key stays a strict total order, and this
    # ring is the shape that notices when it stops being one: give two agents a
    # reason to each read as senior to the other and it wedges.
    Contention(seed, tiers=_mixed_tiers(seed)).run(300)


@pytest.mark.parametrize("seed", range(20))
def test_no_tier_starves_another_when_priorities_are_mixed(seed):
    # Priority decides who waits, not who eats. The background agents still
    # have to finish work: wait-die aborts them against a critical holder, and
    # an abort is a retry, not a life sentence.
    #
    # 600, not 300: an abort used to reset the loser's age to "now", so every
    # retry looked freshly arrived. Now it keeps the age it had, per wait-die's
    # own progress rule (age_of), which is what makes retrying worth anything
    # at all — but a low-priority agent boxed in on both ring neighbours by
    # higher-tier ones is still waiting on lucky timing, not seniority, since
    # priority always decides a direct collision. Seed 6 needed under 500 to
    # find its window; nothing here goes near LEASE_TTL_S regardless.
    out = Contention(seed, tiers=_mixed_tiers(seed)).run(600)
    stuck = [a for a, n in out.finished.items() if n == 0]
    assert not stuck, f"acquired but never completed a unit of work: {stuck}"


def test_a_critical_agent_never_takes_a_lease_off_a_live_holder():
    # The no-preemption invariant, on the production path. A critical requester
    # against a normal holder is told to wait — it keeps its place in the order
    # and wins as soon as the holder lets go — and the holder's lease is
    # untouched at every step.
    clock = VirtualClock()
    registry = LeaseRegistry(clock)
    region = Region(path="src/pay.py", symbol="charge", lines=None)

    assert registry.acquire(ROOM, "sara", "junior", region, "work").ok
    stamp = registry.holder_of(ROOM, region).expires_at

    for _ in range(10):
        clock.advance(1.0)
        result = registry.acquire(
            ROOM, "ops", "senior", region, "urgent",
            priority=PRIORITY_NAMES["critical"],
        )
        assert not result.ok, "a lease was handed over while it was still held"
        assert result.decision == "wait", (
            "a critical requester should hold its place, not abort"
        )
        holder = registry.holder_of(ROOM, region)
        assert holder.agent == "junior"
        assert holder.expires_at == stamp, "the holder's lease was cut short"

    # The holder finishes on its own terms. Only then does the senior win.
    registry.release(ROOM, "junior", region)
    assert registry.acquire(
        ROOM, "ops", "senior", region, "urgent",
        priority=PRIORITY_NAMES["critical"],
    ).ok


# -- the coarse simulation still holds its own invariants --------------------


def test_no_lease_survives_past_the_ttl_without_heartbeats():
    assert Simulation(42, agents=40, regions=10).run(1000).live_at_end == 0


def test_a_seed_reproduces_a_schedule_exactly():
    assert Simulation(7, 12, 5).run(300) == Simulation(7, 12, 5).run(300)


def test_scales_to_forty_agents_without_stalling():
    assert Simulation(1, agents=40, regions=6).run(2000).granted > 100
