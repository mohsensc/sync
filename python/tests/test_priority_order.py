"""The ordering key, and why adding priority to it did not open a deadlock.

Deadlock requires a cycle in the wait-for graph. There is an edge x -> y exactly
when `resolve` tells x to wait on y, which happens exactly when
`key(x) < key(y)`. `key` is a tuple of three totally ordered components with
agent id last, and agent ids are distinct, so `key(x) == key(y)` implies x == y.
That makes the edge relation irreflexive, antisymmetric and transitive — a
strict total order, which has no cycles.

These tests are the argument as executable form: they check the relation itself
rather than sampling the outcomes, so they catch a future "special case" inside
`resolve` on the first run rather than on the unlucky one.
"""

from __future__ import annotations

import itertools
import random

import pytest
from hypothesis import given, settings, strategies as st

from agent_presence.clock import VirtualClock
from agent_presence.leases import LeaseRegistry
from agent_presence.priority import PRIORITY_MAX, PRIORITY_MIN, PRIORITY_NORMAL
from agent_presence.types import Claim, Region
from agent_presence.wait_die import order_key, resolve

ROOM = "r1"
R = Region(path="a.py", symbol=None, lines=None)


def claim(agent: str, acquired_at: float, priority: int = PRIORITY_NORMAL) -> Claim:
    return Claim(
        room=ROOM, human="h", agent=agent, scope=R, intent="", state="held",
        acquired_at=acquired_at, expires_at=acquired_at + 90, priority=priority,
    )


agents = st.text(
    alphabet="abcdefghijklmnopqrstuvwxyz0123456789", min_size=1, max_size=6
)
ages = st.floats(min_value=0, max_value=1e6, allow_nan=False, allow_infinity=False)
tiers = st.integers(min_value=PRIORITY_MIN, max_value=PRIORITY_MAX)
triples = st.tuples(tiers, ages, agents)


# -- 1. the order is total and strict ----------------------------------------


@given(triples)
def test_the_order_is_irreflexive(x):
    assert not (order_key(*x) < order_key(*x))


@given(triples, triples)
def test_the_order_is_antisymmetric(x, y):
    kx, ky = order_key(*x), order_key(*y)
    assert not (kx < ky and ky < kx)


@given(triples, triples, triples)
def test_the_order_is_transitive(x, y, z):
    kx, ky, kz = order_key(*x), order_key(*y), order_key(*z)
    if kx < ky and ky < kz:
        assert kx < kz


@given(triples, triples)
def test_distinct_agents_never_share_a_key(x, y):
    if x[2] != y[2]:
        assert order_key(*x) != order_key(*y)


@given(tiers, ages, tiers, ages, agents, agents)
def test_resolve_is_exactly_the_key_comparison(px, ax, py, ay, x, y):
    # No special cases. The one thing that could reintroduce a cycle is a
    # branch inside resolve that agrees with the key most of the time.
    if x == y:
        return
    verdict = resolve(x, ax, claim(y, ay, py), px)
    expected = "wait" if order_key(px, ax, x) < order_key(py, ay, y) else "abort"
    assert verdict == expected


@given(tiers, ages, tiers, ages, agents, agents)
def test_the_relation_is_never_symmetric_across_random_triples(px, ax, py, ay, x, y):
    # The property the whole design rests on, in the shape the pre-priority
    # version of this test had: two agents can never both be told to wait,
    # whatever their tiers, ages or names.
    if x == y:
        return
    forward = resolve(x, ax, claim(y, ay, py), px)
    reverse = resolve(y, ay, claim(x, ax, px), py)
    assert not (forward == "wait" and reverse == "wait"), (
        f"{x}@{px}/{ax} and {y}@{py}/{ay} are parked on each other"
    )


@given(tiers, ages, tiers, ages, agents, agents)
def test_exactly_one_side_of_every_contest_backs_off(px, ax, py, ay, x, y):
    if x == y:
        return
    verdicts = {
        resolve(x, ax, claim(y, ay, py), px),
        resolve(y, ay, claim(x, ax, px), py),
    }
    assert verdicts == {"wait", "abort"}


# -- what priority actually buys ---------------------------------------------


def test_a_senior_requester_waits_where_a_normal_one_would_have_died():
    # The requirement, stated exactly. Today a fresh agent contending with an
    # older holder is told to abort and retry forever while the holder keeps
    # renewing. A tier above the holder makes it "older" in the order, so it
    # keeps its place instead.
    holder = claim("a1", 100.0, PRIORITY_NORMAL)
    assert resolve("a2", 500.0, holder, PRIORITY_NORMAL) == "abort"
    assert resolve("a2", 500.0, holder, PRIORITY_MAX) == "wait"


def test_priority_outranks_age_and_age_outranks_the_name():
    older_junior = claim("a1", 0.0, PRIORITY_MIN)
    assert resolve("z9", 999.0, older_junior, PRIORITY_NORMAL) == "wait"

    same_tier_older = claim("a1", 0.0, PRIORITY_NORMAL)
    assert resolve("a0", 999.0, same_tier_older, PRIORITY_NORMAL) == "abort"

    same_everything = claim("zz", 5.0, PRIORITY_NORMAL)
    assert resolve("aa", 5.0, same_everything, PRIORITY_NORMAL) == "wait"


def test_a_tier_gap_never_produces_a_third_outcome():
    # No preemption, at any gap. resolve has two outcomes and neither one takes
    # a lease off an agent that is mid-edit.
    for mine, theirs in itertools.product(range(4), repeat=2):
        assert resolve("a1", 10.0, claim("a2", 0.0, theirs), mine) in (
            "wait", "abort"
        )


# -- 4. priority cannot make both sides wait ---------------------------------


def test_the_two_lease_standoff_survives_a_tier_gap():
    # The shape that broke this before priority existed: one agent holding two
    # leases of different ages, so its age and its contested lease's stamp come
    # apart. Add a tier gap on top and both sides have a reason to read as
    # senior. They still cannot both be told to wait.
    clock = VirtualClock()
    registry = LeaseRegistry(clock)
    a_first = Region(path="a1.py", symbol="s", lines=None)
    b_first = Region(path="b1.py", symbol="s", lines=None)
    b_second = Region(path="b2.py", symbol="s", lines=None)

    registry.acquire(ROOM, "dev", "a2", b_first, "first", priority=2)
    clock.advance(10)
    registry.acquire(ROOM, "sara", "a1", a_first, "work", priority=3)
    clock.advance(40)
    registry.acquire(ROOM, "dev", "a2", b_second, "second", priority=2)

    a_to_b = registry.acquire(ROOM, "sara", "a1", b_second, "w", priority=3)
    b_to_a = registry.acquire(ROOM, "dev", "a2", a_first, "w", priority=2)

    assert not (a_to_b.decision == "wait" and b_to_a.decision == "wait")


# -- 3. no cycle, with priority ----------------------------------------------


def _wait_for_edges(registry: LeaseRegistry, rooms) -> set[tuple[str, str]]:
    """Every wait edge the registry would hand out right now, rebuilt from the
    three-part key."""
    edges: set[tuple[str, str]] = set()
    for room in rooms:
        claims = registry.active_claims(room)
        for asker in {c.agent for c in claims}:
            age = registry.age_of(asker)
            tier = registry.priority_of(asker)
            for held in claims:
                if held.agent == asker:
                    continue
                if resolve(asker, age, held, tier) == "wait":
                    edges.add((asker, held.agent))
    return edges


def _find_cycle(edges):
    graph: dict[str, set[str]] = {}
    for a, b in edges:
        graph.setdefault(a, set()).add(b)
    seen, stack = set(), []

    def walk(node):
        if node in stack:
            return stack[stack.index(node):] + [node]
        if node in seen:
            return None
        seen.add(node)
        stack.append(node)
        for nxt in graph.get(node, ()):
            found = walk(nxt)
            if found:
                return found
        stack.pop()
        return None

    for node in list(graph):
        found = walk(node)
        if found:
            return found
    return None


@pytest.mark.parametrize("block", range(4))
def test_random_mixed_tier_schedules_never_produce_a_wait_for_cycle(block):
    """Agents at several tiers holding several leases across several rooms.

    Split into blocks so a failure names a smaller range of seeds; 200 seeds of
    300 steps in total, same as the un-tiered version this is modelled on.
    """
    rooms = ["r1", "r2"]
    regions = [Region(path=f"f{i}.py", symbol="s", lines=None) for i in range(5)]
    agent_ids = [f"a{i}" for i in range(6)]

    for seed in range(block * 50, (block + 1) * 50):
        rand = random.Random(seed)
        clock = VirtualClock(0.0)
        registry = LeaseRegistry(clock)
        # The tier a connection would have been granted at. Fixed per agent for
        # the run, because that is what the relay's join-time latch guarantees.
        tiers_by_agent = {a: rand.randint(0, 3) for a in agent_ids}

        for step in range(300):
            agent = rand.choice(agent_ids)
            room = rand.choice(rooms)
            scope = rand.choice(regions)
            roll = rand.random()

            if roll < 0.6:
                result = registry.acquire(
                    room, "h", agent, scope, "work",
                    priority=tiers_by_agent[agent],
                )
                if not result.ok and result.decision == "abort":
                    registry.release_all(room, agent)
            elif roll < 0.75:
                registry.release(room, agent, scope)
            elif roll < 0.82:
                registry.release_all(room, agent)
            else:
                clock.advance(rand.choice([0.5, 7.0, 40.0]))

            # 2. Stamps never diverge. The regression this catches is
            # "priority read from the connection instead of from the claim".
            for c in registry.active_claims(room):
                assert (c.priority, c.acquired_at) == (
                    registry.priority_of(c.agent), registry.age_of(c.agent)
                ), (
                    f"seed {seed} step {step}: {c.agent}'s claim is stamped "
                    f"{(c.priority, c.acquired_at)} but its key says "
                    f"{registry.key_of(c.agent)}"
                )

            cycle = _find_cycle(_wait_for_edges(registry, rooms))
            assert cycle is None, f"seed {seed} step {step}: wait-for cycle {cycle}"


@settings(max_examples=50, deadline=None)
@given(st.lists(tiers, min_size=2, max_size=6), st.integers(0, 2**32 - 1))
def test_no_generated_tier_population_ever_wedges(population, seed):
    """A ring of agents each holding one region and wanting the next.

    The textbook cycle shape. Every agent obeys its verdict, so a symmetric
    relation really does wedge this and a total order really does keep it
    moving.
    """
    rand = random.Random(seed)
    clock = VirtualClock()
    registry = LeaseRegistry(clock)
    n = len(population)
    regions = [Region(path=f"f{i}.py", symbol="s", lines=None) for i in range(n)]
    holdings = [0] * n

    for _ in range(200):
        order = list(range(n))
        rand.shuffle(order)
        verdicts = []
        for i in order:
            clock.advance(0.005)
            want = regions[(i + holdings[i]) % n]
            result = registry.acquire(
                "r1", "h", f"a{i}", want, "work", priority=population[i]
            )
            if result.ok:
                holdings[i] += 1
                if holdings[i] == 2:
                    registry.release_all("r1", f"a{i}")
                    holdings[i] = 0
                verdicts.append("grant")
            elif result.decision == "abort":
                registry.release_all("r1", f"a{i}")
                holdings[i] = 0
                verdicts.append("abort")
            else:
                verdicts.append("wait")
        assert not all(v == "wait" for v in verdicts), (
            f"every agent waiting at once with tiers {population}"
        )
