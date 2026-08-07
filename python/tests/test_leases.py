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
    assert registry.heartbeat("a1", R)
    clock.advance(LEASE_TTL_S - 1)
    assert registry.holder_of("r1", R).agent == "a1"


def test_rooms_are_isolated_even_with_identical_paths(reg):
    _, registry = reg
    registry.acquire("r1", "sara", "a1", R, "x")
    assert registry.acquire("r2", "dev", "a2", R, "y").ok


def test_release_all_drops_every_lease_for_one_agent(reg):
    _, registry = reg
    other = Region(path="src/db.py", symbol="query", lines=None)
    registry.acquire("r1", "sara", "a1", R, "x")
    registry.acquire("r1", "sara", "a1", other, "y")
    registry.release_all("a1")
    assert registry.active_claims("r1") == []
