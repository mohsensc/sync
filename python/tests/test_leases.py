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
