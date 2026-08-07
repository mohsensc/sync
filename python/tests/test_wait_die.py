import importlib

import pytest
from hypothesis import given, strategies as st

from agent_presence.types import Claim, Region
from agent_presence.wait_die import resolve

R = Region(path="a.py", symbol=None, lines=None)


def claim(agent: str, acquired_at: float) -> Claim:
    return Claim(
        room="r1", human="h", agent=agent, scope=R, intent="",
        state="held", acquired_at=acquired_at, expires_at=acquired_at + 90,
    )


def test_older_requester_waits_for_younger_holder():
    assert resolve("a1", 100.0, claim("a2", 500.0)) == "wait"


def test_younger_requester_aborts_against_older_holder():
    assert resolve("a2", 500.0, claim("a1", 100.0)) == "abort"


def test_exact_ties_break_deterministically_by_agent_id():
    assert resolve("aaa", 100.0, claim("bbb", 100.0)) != resolve("bbb", 100.0, claim("aaa", 100.0))


@given(
    x=st.floats(min_value=0, max_value=1e6, allow_nan=False),
    y=st.floats(min_value=0, max_value=1e6, allow_nan=False),
)
def test_relation_is_never_symmetric_which_is_what_forbids_wait_cycles(x, y):
    forward = resolve("a1", x, claim("a2", y))
    reverse = resolve("a2", y, claim("a1", x))
    assert not (forward == "wait" and reverse == "wait")


def test_the_module_is_named_for_the_algorithm_it_actually_implements():
    # The old name said wound-wait while the code did wait-die. Renaming was
    # the fix, so the old module must be gone, not aliased.
    with pytest.raises(ModuleNotFoundError):
        importlib.import_module("agent_presence.wound_wait")


def test_the_docstring_does_not_claim_wound_wait():
    doc = resolve.__doc__.lower()
    assert "wait-die" in doc
    # Wound-wait is named only to explain why it was rejected.
    assert "preempt" in doc


def test_an_older_requester_never_preempts_the_holder():
    # Wound-wait would return something meaning "take it". Wait-die has only
    # two outcomes and neither one removes the holder's lease.
    assert resolve("a1", 100.0, claim("a2", 500.0)) in ("wait", "abort")
    assert resolve("a1", 100.0, claim("a2", 500.0)) != "abort"
