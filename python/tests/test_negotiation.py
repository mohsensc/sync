import pytest

from agent_presence.clock import VirtualClock
from agent_presence.leases import LeaseRegistry
from agent_presence.negotiation import Negotiator
from agent_presence.types import Region

R = Region(path="src/auth.py", symbol="sign_in", lines=None)
OTHER = Region(path="src/auth.py", symbol="sign_out", lines=None)


@pytest.fixture
def neg():
    clock = VirtualClock()
    registry = LeaseRegistry(clock)
    registry.acquire("r1", "sara", "a1", R, "refactor session handling")
    return clock, registry, Negotiator(registry, clock)


def test_brief_names_the_holder_and_their_intent(neg):
    _, _, n = neg
    brief = n.open("r1", "a2", 500.0, R, "rename")
    assert brief.holder_agent == "a1"
    assert brief.holder_intent == "refactor session handling"


def test_brief_offers_exactly_the_four_moves(neg):
    _, _, n = neg
    brief = n.open("r1", "a2", 500.0, R, "rename")
    assert brief.moves == ("DEFER", "SPLIT", "HANDOFF", "PROCEED")


def test_no_brief_when_the_region_is_free(neg):
    _, _, n = neg
    assert n.open("r1", "a2", 500.0, OTHER, "unrelated") is None


def test_defer_does_not_grant(neg):
    _, _, n = neg
    outcome = n.apply("r1", "a2", R, "DEFER")
    assert not outcome.granted


def test_split_grants_a_disjoint_region(neg):
    _, registry, n = neg
    outcome = n.apply("r1", "a2", OTHER, "SPLIT")
    assert outcome.granted
    assert registry.holder_of("r1", OTHER).agent == "a2"


def test_handoff_drops_the_requester_claim_and_leaves_the_holder(neg):
    _, registry, n = neg
    outcome = n.apply("r1", "a2", R, "HANDOFF")
    assert not outcome.granted
    assert registry.holder_of("r1", R).agent == "a1"


def test_proceed_is_always_available_and_is_logged_as_an_override(neg):
    _, _, n = neg
    outcome = n.apply("r1", "a2", R, "PROCEED", reason="independent change")
    assert outcome.granted
    assert outcome.logged_override


def test_unknown_move_is_rejected(neg):
    _, _, n = neg
    with pytest.raises(ValueError):
        n.apply("r1", "a2", R, "ARGUE")
