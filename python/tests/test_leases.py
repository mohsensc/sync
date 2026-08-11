import pytest

from agent_presence.clock import VirtualClock
from agent_presence.leases import LEASE_TTL_S, LeaseRegistry
from agent_presence.types import Region

R = Region(path="src/auth.py", symbol="sign_in", lines=None)


@pytest.fixture
def reg():
    clock = VirtualClock()
    return clock, LeaseRegistry(clock)


def test_uncontested_lease_is_granted(reg):
    _, registry = reg
    assert registry.acquire("r1", "sara", "a1", R, "refactor").ok


def test_second_lease_on_same_region_is_refused_and_names_the_holder(reg):
    _, registry = reg
    registry.acquire("r1", "sara", "a1", R, "refactor")
    result = registry.acquire("r1", "dev", "a2", R, "rename")
    assert not result.ok
    assert result.held_by.agent == "a1"


def test_lease_expires_after_ttl_with_no_manual_cleanup(reg):
    clock, registry = reg
    registry.acquire("r1", "sara", "a1", R, "refactor")
    clock.advance(LEASE_TTL_S + 1)
    assert registry.acquire("r1", "dev", "a2", R, "rename").ok


def test_heartbeat_extends_the_lease(reg):
    clock, registry = reg
    registry.acquire("r1", "sara", "a1", R, "refactor")
    clock.advance(LEASE_TTL_S - 1)
    assert registry.heartbeat("r1", "a1", R)
    clock.advance(LEASE_TTL_S - 1)
    assert registry.holder_of("r1", R).agent == "a1"


def test_rooms_are_isolated_even_with_identical_paths(reg):
    _, registry = reg
    registry.acquire("r1", "sara", "a1", R, "x")
    assert registry.acquire("r2", "dev", "a2", R, "y").ok


def test_release_all_drops_every_lease_an_agent_holds_in_the_room(reg):
    _, registry = reg
    other = Region(path="src/db.py", symbol="query", lines=None)
    registry.acquire("r1", "sara", "a1", R, "x")
    registry.acquire("r1", "sara", "a1", other, "y")
    registry.release_all("r1", "a1")
    assert registry.active_claims("r1") == []


# -- room scoping ------------------------------------------------------------


def test_release_cannot_reach_across_rooms(reg):
    _, registry = reg
    registry.acquire("r1", "sara", "a1", R, "refactor")
    registry.release("r2", "a1", R)
    assert registry.holder_of("r1", R) is not None


def test_heartbeat_cannot_reach_across_rooms(reg):
    _, registry = reg
    registry.acquire("r1", "sara", "a1", R, "refactor")
    assert not registry.heartbeat("r2", "a1", R)


def test_release_still_works_in_the_right_room(reg):
    _, registry = reg
    registry.acquire("r1", "sara", "a1", R, "refactor")
    registry.release("r1", "a1", R)
    assert registry.holder_of("r1", R) is None


def test_release_all_cannot_reach_across_rooms(reg):
    # presenced names itself presenced@<hostname>, so two checkouts on one
    # laptop are two rooms sharing one agent id. A sweep triggered by something
    # that happened in r2 must not touch r1.
    _, registry = reg
    registry.acquire("r1", "sara", "a1", R, "the innocent lease")
    registry.acquire("r2", "sara", "a1", R, "the one that goes")
    registry.release_all("r2", "a1")
    assert registry.holder_of("r2", R) is None
    held = registry.active_claims("r1")
    assert [c.intent for c in held] == ["the innocent lease"]


# -- wait-die on refusal -----------------------------------------------------


def test_a_refused_claim_carries_a_wait_die_decision(reg):
    _, registry = reg
    registry.acquire("r1", "sara", "a1", R, "refactor")
    result = registry.acquire("r1", "dev", "a2", R, "rename")
    assert not result.ok
    assert result.decision in ("wait", "abort")


def test_a_brand_new_requester_is_younger_and_therefore_dies(reg):
    clock, registry = reg
    registry.acquire("r1", "sara", "a1", R, "refactor")
    clock.advance(5)
    assert registry.acquire("r1", "dev", "a2", R, "rename").decision == "abort"


def test_a_requester_holding_an_older_lease_waits_instead(reg):
    clock, registry = reg
    other = Region(path="src/db.py", symbol="query", lines=None)
    registry.acquire("r1", "dev", "a2", other, "old work")   # a2 is old
    clock.advance(5)
    registry.acquire("r1", "sara", "a1", R, "refactor")      # a1 is young
    assert registry.acquire("r1", "dev", "a2", R, "rename").decision == "wait"


def test_age_is_the_oldest_live_claim_not_the_newest(reg):
    clock, registry = reg
    other = Region(path="src/db.py", symbol="query", lines=None)
    registry.acquire("r1", "sara", "a1", R, "first")
    clock.advance(10)
    registry.acquire("r1", "sara", "a1", other, "second")
    assert registry.age_of("a1") == 0.0


def test_age_of_an_agent_holding_nothing_is_now(reg):
    clock, registry = reg
    clock.advance(7)
    assert registry.age_of("nobody") == 7.0


def test_a_voluntary_release_lets_the_next_ask_start_fresh(reg):
    """`release` is always voluntary in production -- the wire "release"
    frame and HANDOFF are its only two callers, and both mean this agent is
    done here, not that it was forced off. Letting go of the last thing it
    held closes out whatever it was doing, so the next ask is new work and
    gets a new age -- otherwise the first agent to ever connect would
    outrank the whole room forever (see the ring simulation in
    test_invariants.py, which is exactly what a permanently-latched age
    breaks).
    """
    clock, registry = reg
    registry.acquire("r1", "sara", "a1", R, "refactor")   # a1's age is 0.0
    registry.release("r1", "a1", R)                         # a clean finish
    clock.advance(100)
    assert registry.age_of("a1") == 100.0


def test_age_survives_a_wait_die_abort(reg):
    """The other half of the rule. `release_all`'s own docstring: used on
    session end and on a wait-die abort -- neither is a transaction
    concluding on its own terms, so unlike `release`, it must not reset
    `_first_seen`. Wait-die's whole progress guarantee is that a loser keeps
    its place in line and retries with the *same* age; resetting it here is
    what made a requester with no live lease always read as brand new, no
    matter how many times it had already been refused.
    """
    clock, registry = reg
    registry.acquire("r1", "sara", "a1", R, "refactor")   # a1's age is 0.0
    registry.release_all("r1", "a1")                        # a forced sweep
    clock.advance(100)
    assert registry.age_of("a1") == 0.0


def test_a_repeatedly_aborted_requester_eventually_waits(reg):
    """The real shape the swarm harness hits: an agent contests a region,
    loses, and the relay's own abort path drops its leases via
    `release_all` -- not a release it chose. If that reset its age, the
    requester would look freshly arrived on every single retry and could
    never accumulate enough seniority to be told `wait` instead of `abort`,
    which is exactly how `decision:wait` stayed at zero under load.
    """
    clock, registry = reg
    other = Region(path="src/db.py", symbol="query", lines=None)
    registry.acquire("r1", "dev", "a2", other, "old work")   # a2's age: 0.0
    registry.release_all("r1", "a2")                          # a loss, not a finish
    clock.advance(5)
    registry.acquire("r1", "sara", "a1", R, "refactor")       # a1's age: 5.0
    clock.advance(5)
    # a2 is still, in truth, the older of the two; wait-die tells it to wait
    # rather than die again.
    assert registry.acquire("r1", "dev", "a2", R, "rename").decision == "wait"


def test_an_agent_id_that_changes_hands_does_not_inherit_the_old_age(reg):
    """`release_everywhere` is the identity-handoff path -- the same one that
    already strips a stale tier off a reused agent id (see
    `Relay._drop_stranded_claims`). Age has to be stripped there too, or a
    fresh connection that reuses an old id inherits seniority nobody granted
    it, the same laundering the tier fix closed on the other axis.
    """
    clock, registry = reg
    registry.acquire("r1", "sara", "a1", R, "refactor")  # a1's age latches to 0.0
    registry.release_everywhere("a1")
    clock.advance(50)
    assert registry.age_of("a1") == 50.0


def test_a_granted_claim_carries_no_decision(reg):
    _, registry = reg
    assert registry.acquire("r1", "sara", "a1", R, "refactor").decision is None


# -- file-level scope --------------------------------------------------------


def test_a_whole_file_claim_blocks_a_symbol_claim_in_that_file(reg):
    _, registry = reg
    whole = Region(path="src/auth.py", symbol=None, lines=None)
    registry.acquire("r1", "sara", "a1", whole, "rewriting the file")
    result = registry.acquire("r1", "dev", "a2", R, "rename")
    assert not result.ok
    assert result.held_by.agent == "a1"


def test_a_symbol_claim_blocks_a_whole_file_claim(reg):
    _, registry = reg
    whole = Region(path="src/auth.py", symbol=None, lines=None)
    registry.acquire("r1", "sara", "a1", R, "refactor")
    assert not registry.acquire("r1", "dev", "a2", whole, "rewrite").ok
