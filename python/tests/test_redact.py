import pytest

from agent_presence.redact import FORBIDDEN_FIELDS, opaque_region, redact
from agent_presence.types import Region


def raw():
    return {
        "room": "r1", "human": "sara", "agent": "a1", "kind": "touch",
        "source": "hook", "verb": "edit",
        "region": {"path": "src/auth.py", "symbol": "sign_in", "lines": [1, 9]},
        "content": "SECRET_KEY = 'hunter2'",
        "diff": "- old\n+ new",
        "prompt": "refactor this",
        "env": {"AWS_SECRET_ACCESS_KEY": "x"},
    }


@pytest.mark.parametrize("field", sorted(FORBIDDEN_FIELDS))
def test_every_forbidden_field_is_stripped(field):
    out = redact(raw())
    assert field not in out


def test_permitted_fields_survive():
    out = redact(raw())
    assert out["region"]["path"] == "src/auth.py"
    assert out["region"]["symbol"] == "sign_in"
    assert out["verb"] == "edit"


def test_no_secret_value_survives_anywhere_in_the_payload():
    assert "hunter2" not in repr(redact(raw()))


def test_opaque_mode_hashes_path_and_symbol():
    r = Region(path="src/auth.py", symbol="sign_in", lines=(1, 9))
    o = opaque_region(r)
    assert "auth" not in o.path
    assert o.symbol is not None and "sign_in" not in o.symbol


def test_opaque_mode_preserves_equality_so_collisions_still_detect():
    a = Region(path="src/auth.py", symbol="sign_in", lines=(1, 9))
    b = Region(path="src/auth.py", symbol="sign_in", lines=(40, 80))
    assert opaque_region(a).path == opaque_region(b).path
    assert opaque_region(a).symbol == opaque_region(b).symbol


def test_opaque_mode_keeps_distinct_regions_distinct():
    a = Region(path="src/auth.py", symbol="sign_in", lines=None)
    b = Region(path="src/db.py", symbol="sign_in", lines=None)
    assert opaque_region(a).path != opaque_region(b).path
