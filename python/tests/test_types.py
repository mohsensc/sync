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
