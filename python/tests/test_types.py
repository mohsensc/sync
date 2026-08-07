from agent_presence.types import Region, same_region


def test_same_path_and_symbol_is_the_same_region():
    a = Region(path="src/auth.py", symbol="sign_in", lines=(10, 20))
    b = Region(path="src/auth.py", symbol="sign_in", lines=(30, 40))
    assert same_region(a, b)


def test_different_symbols_in_one_file_are_different_regions():
    a = Region(path="src/auth.py", symbol="sign_in", lines=None)
    b = Region(path="src/auth.py", symbol="sign_out", lines=None)
    assert not same_region(a, b)


def test_regions_are_hashable_so_they_can_key_a_cache():
    r = Region(path="a.py", symbol="f", lines=None)
    assert len({r, Region(path="a.py", symbol="f", lines=None)}) == 1


# -- symbol=None means "the whole file" -------------------------------------


def test_a_file_level_claim_conflicts_with_a_symbol_in_that_file():
    whole = Region(path="src/auth.py", symbol=None, lines=None)
    part = Region(path="src/auth.py", symbol="sign_in", lines=None)
    assert same_region(whole, part)


def test_the_file_level_rule_is_symmetric():
    whole = Region(path="src/auth.py", symbol=None, lines=None)
    part = Region(path="src/auth.py", symbol="sign_in", lines=None)
    assert same_region(part, whole)


def test_two_file_level_claims_on_one_path_conflict():
    a = Region(path="src/auth.py", symbol=None, lines=None)
    b = Region(path="src/auth.py", symbol=None, lines=None)
    assert same_region(a, b)


def test_a_file_level_claim_does_not_reach_into_another_file():
    whole = Region(path="src/auth.py", symbol=None, lines=None)
    elsewhere = Region(path="src/db.py", symbol="query", lines=None)
    assert not same_region(whole, elsewhere)


def test_the_rule_is_documented():
    assert "whole file" in same_region.__doc__
