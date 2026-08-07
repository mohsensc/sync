"""The two-lease wait cycle the ring test in test_invariants.py cannot reach.

That ring gives every agent at most one lease at a time, so an agent's wait-die
age is always the acquired_at of its single claim. Requester key and holder key
happen to be the same quantity and the relation looks antisymmetric.

Give one agent two leases and the two keys come apart: the requester is ordered
by ``age_of`` (its *oldest* live claim) while the holder is ordered by the
acquired_at of the *particular* claim being contested, which is younger. Both
sides can then read as "older", both are told to wait, and neither ever dies.
"""

from __future__ import annotations

from agent_presence.clock import VirtualClock
from agent_presence.leases import LEASE_TTL_S, LeaseRegistry
from agent_presence.relay import Relay
from agent_presence.types import Region

ROOM = "r1"


def region(path: str) -> Region:
    return Region(path=path, symbol="sym", lines=None)


def wire_region(path: str) -> dict:
    return {"path": path, "symbol": "sym", "lines": None}


class FakeConn:
    def __init__(self, agent: str, human: str) -> None:
        self.agent, self.human, self.room = agent, human, None
        self.sent: list[dict] = []

    def send(self, payload: dict) -> None:
        self.sent.append(payload)


# -- the invariant that makes the relation antisymmetric ---------------------


def test_every_live_claim_is_stamped_with_its_agents_wait_die_age():
    # resolve() reads the requester's age off age_of and the holder's off
    # holder.acquired_at. Those are only comparable while every claim an agent
    # holds carries that agent's age. Break this and the ordering stops being a
    # total order over agents, which is the whole basis for deadlock freedom.
    clock = VirtualClock(0.0)
    registry = LeaseRegistry(clock)

    registry.acquire(ROOM, "dev", "a2", region("b1.py"), "first")
    clock.advance(10)
    registry.acquire(ROOM, "sara", "a1", region("a1.py"), "work")
    clock.advance(40)
    registry.acquire(ROOM, "dev", "a2", region("b2.py"), "second")

    for c in registry.active_claims(ROOM):
        assert c.acquired_at == registry.age_of(c.agent), (
            f"{c.agent}'s claim on {c.scope.path} is stamped {c.acquired_at} "
            f"but the agent's age is {registry.age_of(c.agent)}"
        )


# -- the cycle, through the production claim path ----------------------------


def _two_lease_standoff() -> tuple[Relay, FakeConn, FakeConn]:
    """a2 takes a lease, a1 takes one, then a2 takes a second, younger one.

    a2's age is now older than a1's, but a2's *contested* lease is younger than
    a1's. That gap is the whole bug.
    """
    relay = Relay(VirtualClock(0.0))
    a, b = FakeConn("a1", "sara"), FakeConn("a2", "dev")
    relay.join(ROOM, a)
    relay.join(ROOM, b)

    def claim(conn: FakeConn, path: str) -> dict:
        return relay.handle(
            conn, {"type": "claim", "region": wire_region(path), "intent": "work"}
        )

    assert claim(b, "b1.py")["granted"] is True     # t=0
    relay._clock.advance(10)
    assert claim(a, "a1.py")["granted"] is True     # t=10
    relay._clock.advance(40)
    assert claim(b, "b2.py")["granted"] is True     # t=50
    relay._clock.advance(10)
    return relay, a, b


def test_two_agents_holding_leases_cannot_both_be_told_to_wait():
    relay, a, b = _two_lease_standoff()

    a_to_b = relay.handle(
        a, {"type": "claim", "region": wire_region("b2.py"), "intent": "work"}
    )
    b_to_a = relay.handle(
        b, {"type": "claim", "region": wire_region("a1.py"), "intent": "work"}
    )

    # A grant is a fine outcome — it means the standoff already broke. What is
    # not fine is both sides being parked on each other.
    assert not (
        a_to_b.get("decision") == "wait" and b_to_a.get("decision") == "wait"
    ), "a1 waits on a2 and a2 waits on a1: that is a wait-for cycle"


def test_the_standoff_resolves_instead_of_running_out_the_lease_ttl():
    # Retrying is what a waiter is told to do, so retry. Wait-die has to break
    # the tie on its own; if the only thing that ever unblocks these two is the
    # 90s TTL expiring, deadlock is not unreachable, it is merely time-limited.
    relay, a, b = _two_lease_standoff()

    def retry() -> tuple[dict, dict]:
        return (
            relay.handle(
                a, {"type": "claim", "region": wire_region("b2.py"), "intent": "w"}
            ),
            relay.handle(
                b, {"type": "claim", "region": wire_region("a1.py"), "intent": "w"}
            ),
        )

    start = relay._clock.now()
    for _ in range(40):
        first, second = retry()
        if first["granted"] or second["granted"]:
            break
        if "abort" in (first.get("decision"), second.get("decision")):
            break
        # A waiter keeps what it holds and keeps it alive.
        for conn, paths in ((a, ["a1.py"]), (b, ["b1.py", "b2.py"])):
            for p in paths:
                relay.handle(
                    conn, {"type": "heartbeat", "region": wire_region(p)}
                )
        relay._clock.advance(1.0)
    else:
        raise AssertionError(
            "40 rounds of retries and neither agent was ever told to abort or "
            "granted anything: the two are wedged on each other"
        )

    assert relay._clock.now() - start < LEASE_TTL_S, (
        "only the lease TTL broke the standoff, not wait-die"
    )


# -- searching for a cycle of any length -------------------------------------


def _wait_for_edges(registry: LeaseRegistry, rooms, regions):
    """Every wait edge the registry would hand out right now.

    An edge x -> y means: if x asked for the region y holds, wait-die would tell
    x to sit and wait. A cycle in this graph is a deadlock, whatever its length.
    """
    from agent_presence.wait_die import resolve

    edges: set[tuple[str, str]] = set()
    for room in rooms:
        claims = registry.active_claims(room)
        agents = {c.agent for c in claims}
        for asker in agents:
            age = registry.age_of(asker)
            for held in claims:
                if held.agent == asker:
                    continue
                if resolve(asker, age, held) == "wait":
                    edges.add((asker, held.agent))
    return edges


def _find_cycle(edges):
    graph: dict[str, set[str]] = {}
    for a, b in edges:
        graph.setdefault(a, set()).add(b)
    seen, stack = set(), []

    def walk(node) -> list[str] | None:
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


def test_random_schedules_never_produce_a_wait_for_cycle():
    """Agents holding several leases across several rooms, plus expiry.

    This is the shape the ring model in test_invariants.py deliberately does not
    have: there every agent holds at most one lease, so an agent's age and its
    lease's stamp are the same number by accident. Here they are only the same
    number if acquire keeps them that way.
    """
    import random

    rooms = ["r1", "r2"]
    regions = [region(f"f{i}.py") for i in range(5)]
    agent_ids = [f"a{i}" for i in range(6)]

    for seed in range(200):
        rand = random.Random(seed)
        clock = VirtualClock(0.0)
        registry = LeaseRegistry(clock)

        for step in range(300):
            agent = rand.choice(agent_ids)
            room = rand.choice(rooms)
            scope = rand.choice(regions)
            roll = rand.random()

            if roll < 0.6:
                result = registry.acquire(room, "h", agent, scope, "work")
                if not result.ok and result.decision == "abort":
                    registry.release_all(agent)
            elif roll < 0.75:
                registry.release(room, agent, scope)
            elif roll < 0.82:
                registry.release_all(agent)
            else:
                clock.advance(rand.choice([0.5, 7.0, 40.0]))

            for c in registry.active_claims(room):
                assert c.acquired_at == registry.age_of(c.agent), (
                    f"seed {seed} step {step}: {c.agent}'s stamp {c.acquired_at} "
                    f"!= its age {registry.age_of(c.agent)}"
                )

            cycle = _find_cycle(_wait_for_edges(registry, rooms, regions))
            assert cycle is None, f"seed {seed} step {step}: wait-for cycle {cycle}"
