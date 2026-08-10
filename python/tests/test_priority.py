from __future__ import annotations

import pytest
from hypothesis import given, strategies as st

from agent_presence.clock import VirtualClock
from agent_presence.leases import LeaseRegistry
from agent_presence.priority import (
    PRIORITY_MAX,
    PRIORITY_MIN,
    PRIORITY_NAMES,
    PRIORITY_NORMAL,
    clamp,
    name_of,
    parse_priority,
)
from agent_presence.types import Region

R = Region(path="src/pay.py", symbol="charge", lines=None)
ROOM = "r1"


# -- the four names ----------------------------------------------------------


def test_there_are_exactly_four_tiers():
    # Four names, not an open integer range. An open range is an arms race;
    # four names force a conversation. If a fifth ever gets added it should be
    # a decision somebody made, not a diff nobody noticed.
    assert list(PRIORITY_NAMES) == ["background", "normal", "elevated", "critical"]
    assert (PRIORITY_MIN, PRIORITY_NORMAL, PRIORITY_MAX) == (0, 1, 3)


def test_normal_is_the_identity_element():
    assert PRIORITY_NAMES["normal"] == PRIORITY_NORMAL
    assert name_of(PRIORITY_NORMAL) == "normal"


@pytest.mark.parametrize("name,value", sorted(PRIORITY_NAMES.items()))
def test_tier_names_round_trip(name, value):
    assert parse_priority(name) == value
    assert name_of(value) == name


@pytest.mark.parametrize("raw", [" Critical ", "CRITICAL", "eLeVaTeD"])
def test_tier_names_are_case_and_whitespace_insensitive(raw):
    assert parse_priority(raw) == PRIORITY_NAMES[raw.strip().lower()]


@pytest.mark.parametrize("bad", ["urgent", "", "  ", "9", "normalish"])
def test_unknown_tier_names_raise(bad):
    with pytest.raises(ValueError):
        parse_priority(bad)


@pytest.mark.parametrize("bad", [-1, 4, 100])
def test_out_of_range_integers_raise(bad):
    with pytest.raises(ValueError):
        parse_priority(bad)


def test_a_boolean_is_not_a_tier():
    # bool is an int in Python, so `attended = true` would quietly parse as 1,
    # which is `normal`, which is the answer you get for a typo you never see.
    with pytest.raises(ValueError, match="boolean"):
        parse_priority(True)


@pytest.mark.parametrize("bad", [None, 1.5, [], {}, object()])
def test_anything_else_raises(bad):
    with pytest.raises(ValueError):
        parse_priority(bad)


@pytest.mark.parametrize("value,expected", [(-5, 0), (0, 0), (3, 3), (99, 3)])
def test_clamp_folds_into_the_four_tiers(value, expected):
    assert clamp(value) == expected


@given(st.integers(min_value=-1000, max_value=1000))
def test_name_of_never_renders_a_tier_nobody_has_heard_of(value):
    assert name_of(value) in PRIORITY_NAMES


# -- the tier is latched on the agent, not on the lease ----------------------


def test_a_second_lease_inherits_the_tier_of_the_first():
    # The same trick acquired_at plays, one component to the left. An agent
    # holding two claims at two tiers reads as senior when it asks and junior
    # when it is asked, which is the asymmetry that opens a wait-for cycle.
    clock = VirtualClock()
    registry = LeaseRegistry(clock)
    other = Region(path="src/db.py", symbol="query", lines=None)

    registry.acquire(ROOM, "sara", "a1", R, "first", priority=3)
    clock.advance(10)
    registry.acquire(ROOM, "sara", "a1", other, "second", priority=0)

    tiers = {c.priority for c in registry.active_claims(ROOM)}
    assert tiers == {3}, "the second claim was stamped with its own tier"


def test_priority_of_an_agent_holding_nothing_is_the_default():
    registry = LeaseRegistry(VirtualClock())
    assert registry.priority_of("nobody") == PRIORITY_NORMAL
    assert registry.priority_of("nobody", default=2) == 2


def test_priority_of_reads_the_stamp_not_the_argument():
    registry = LeaseRegistry(VirtualClock())
    registry.acquire(ROOM, "sara", "a1", R, "work", priority=2)
    assert registry.priority_of("a1", default=0) == 2


def test_the_tier_is_not_room_scoped():
    # age_of is global for the same reason: a wait-for cycle can run through
    # leases in more than one room, and an agent that reads critical in one
    # room and normal in another is exactly that asymmetry.
    registry = LeaseRegistry(VirtualClock())
    registry.acquire("r1", "sara", "a1", R, "work", priority=3)
    assert registry.priority_of("a1") == 3
    other = registry.acquire("r2", "sara", "a1", R, "work", priority=0)
    assert other.claim.priority == 3


def test_key_of_agrees_with_the_stamp_on_every_claim():
    clock = VirtualClock()
    registry = LeaseRegistry(clock)
    other = Region(path="src/db.py", symbol="query", lines=None)
    registry.acquire(ROOM, "sara", "a1", R, "first", priority=2)
    clock.advance(5)
    registry.acquire(ROOM, "sara", "a1", other, "second", priority=2)

    for claim in registry.active_claims(ROOM):
        assert (claim.priority, claim.acquired_at) == (
            registry.priority_of(claim.agent),
            registry.age_of(claim.agent),
        )
        assert registry.key_of(claim.agent) == (
            -claim.priority, claim.acquired_at, claim.agent
        )
