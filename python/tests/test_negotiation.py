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
    # Rejected, but as data. Raising here would escape through the MCP tool
    # call and the agent would see a stack trace instead of an answer.
    _, _, n = neg
    outcome = n.apply("r1", "a2", R, "ARGUE")
    assert not outcome.granted
    assert outcome.action == "invalid_move"


# -- (E) SPLIT must be distinguishable from DEFER ----------------------------


def test_split_onto_the_contested_region_is_rejected_not_silently_deferred(neg):
    _, registry, n = neg
    outcome = n.apply("r1", "a2", R, "SPLIT")
    assert not outcome.granted
    assert outcome.action == "split_rejected"
    assert outcome.action != "defer"
    assert "disjoint" in outcome.error
    assert registry.holder_of("r1", R).agent == "a1"


def test_split_claims_the_named_disjoint_sub_region(neg):
    _, registry, n = neg
    outcome = n.apply("r1", "a2", R, "SPLIT", split_scope=OTHER)
    assert outcome.granted
    assert outcome.action == "split"
    assert registry.holder_of("r1", OTHER).agent == "a2"
    # The holder keeps what it had.
    assert registry.holder_of("r1", R).agent == "a1"


def test_a_whole_file_split_is_not_disjoint_from_a_symbol_holder(neg):
    _, _, n = neg
    whole = Region(path="src/auth.py", symbol=None, lines=None)
    outcome = n.apply("r1", "a2", R, "SPLIT", split_scope=whole)
    assert not outcome.granted
    assert outcome.action == "split_rejected"


def test_split_onto_a_region_someone_else_already_holds_is_rejected(neg):
    _, registry, n = neg
    registry.acquire("r1", "kim", "a3", OTHER, "already mine")
    outcome = n.apply("r1", "a2", R, "SPLIT", split_scope=OTHER)
    assert not outcome.granted
    assert outcome.action == "split_rejected"
    assert "a3" in outcome.error


# -- (F) move names ----------------------------------------------------------


def test_move_names_are_case_insensitive(neg):
    _, registry, n = neg
    assert n.apply("r1", "a2", R, "split", split_scope=OTHER).granted
    assert n.apply("r1", "a2", R, "  Proceed  ").granted


def test_lowercase_defer_is_still_a_defer(neg):
    _, _, n = neg
    assert n.apply("r1", "a2", R, "defer").action == "defer"


def test_an_invented_move_returns_a_structured_error_instead_of_raising(neg):
    _, _, n = neg
    outcome = n.apply("r1", "a2", R, "ARGUE")
    assert not outcome.granted
    assert outcome.action == "invalid_move"
    assert "ARGUE" in outcome.error
    assert "DEFER" in outcome.error


def test_a_non_string_move_does_not_blow_up(neg):
    _, _, n = neg
    assert n.apply("r1", "a2", R, None).action == "invalid_move"


# -- (G) the brief uses the age it was handed --------------------------------


def test_a_younger_requester_is_told_to_abort(neg):
    _, _, n = neg
    brief = n.open("r1", "a2", 500.0, R, "rename")
    assert brief.decision == "abort"


def test_an_older_requester_is_told_to_wait(neg):
    _, _, n = neg
    brief = n.open("r1", "a2", -500.0, R, "rename")
    assert brief.decision == "wait"
