import pytest

from agent_presence.redact import (
    FORBIDDEN_FIELDS,
    PERMITTED_TOP_LEVEL,
    opaque_region,
    redact,
)
from agent_presence.types import Region

SECRET = "hunter2"


@pytest.fixture(autouse=True)
def _opaque_off(monkeypatch):
    monkeypatch.delenv("AGENT_PRESENCE_OPAQUE", raising=False)


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


# -- a permitted key is a permitted name, not a permitted value ---------------


@pytest.mark.parametrize("field", sorted(PERMITTED_TOP_LEVEL))
def test_a_secret_hidden_in_a_dict_under_a_permitted_key_does_not_survive(field):
    payload = raw()
    payload[field] = {"content": f"SECRET_KEY = '{SECRET}'"}
    assert SECRET not in repr(redact(payload))


@pytest.mark.parametrize("field", sorted(PERMITTED_TOP_LEVEL))
def test_a_secret_hidden_in_a_list_under_a_permitted_key_does_not_survive(field):
    payload = raw()
    payload[field] = ["edit", {"env": {"AWS_SECRET_ACCESS_KEY": SECRET}}]
    assert SECRET not in repr(redact(payload))


@pytest.mark.parametrize("field", sorted(PERMITTED_TOP_LEVEL))
def test_a_secret_buried_three_levels_under_a_permitted_key_does_not_survive(field):
    payload = raw()
    payload[field] = {"a": {"b": [{"stdout": SECRET}]}}
    assert SECRET not in repr(redact(payload))


@pytest.mark.parametrize("region_key", ["path", "symbol", "lines"])
def test_a_secret_hidden_in_a_region_field_does_not_survive(region_key):
    payload = raw()
    payload["region"][region_key] = {"prompt": SECRET}
    assert SECRET not in repr(redact(payload))


def test_permitted_keys_holding_the_wrong_type_are_dropped():
    out = redact({
        "room": ["r1"], "human": 7, "agent": True, "verb": {"v": "edit"},
        "kind": None, "source": (), "intent": 3.5, "ts": "not-a-number",
        "region": "src/auth.py",
    })
    assert out == {}


def test_region_is_rebuilt_field_by_field():
    payload = raw()
    payload["region"]["extra"] = {"diff": SECRET}
    assert redact(payload)["region"] == {
        "path": "src/auth.py", "symbol": "sign_in", "lines": [1, 9],
    }


def test_a_bogus_line_range_is_dropped_not_forwarded():
    payload = raw()
    payload["region"]["lines"] = [1, 2, 3]
    assert redact(payload)["region"]["lines"] is None


# -- opaque mode is wired to a config flag ------------------------------------


def test_opaque_mode_is_off_unless_the_flag_is_set():
    assert redact(raw())["region"]["path"] == "src/auth.py"


def test_opaque_flag_removes_cleartext_paths_from_the_payload(monkeypatch):
    monkeypatch.setenv("AGENT_PRESENCE_OPAQUE", "1")
    out = redact(raw())
    text = repr(out)
    assert "src/auth.py" not in text
    assert "auth" not in text
    assert "sign_in" not in text
    expected = opaque_region(Region(path="src/auth.py", symbol="sign_in", lines=None))
    assert out["region"]["path"] == expected.path
    assert out["region"]["symbol"] == expected.symbol
    assert out["region"]["lines"] is None


def test_opaque_flag_still_detects_collisions(monkeypatch):
    monkeypatch.setenv("AGENT_PRESENCE_OPAQUE", "1")

    def ev(path, symbol, lines):
        return redact({"verb": "edit",
                       "region": {"path": path, "symbol": symbol, "lines": lines}})

    same_a = ev("src/auth.py", "sign_in", [1, 9])
    same_b = ev("src/auth.py", "sign_in", [40, 80])
    other = ev("src/db.py", "sign_in", None)
    assert same_a["region"]["path"] == same_b["region"]["path"]
    assert same_a["region"]["symbol"] == same_b["region"]["symbol"]
    assert same_a["region"]["path"] != other["region"]["path"]


def test_opaque_hashing_is_not_applied_twice(monkeypatch):
    from agent_presence.redact import apply_opaque

    monkeypatch.setenv("AGENT_PRESENCE_OPAQUE", "1")
    once = redact(raw())
    assert apply_opaque(once) == once


def test_opaque_flag_reaches_flattened_path_fields_too(monkeypatch):
    from agent_presence.redact import apply_opaque

    monkeypatch.setenv("AGENT_PRESENCE_OPAQUE", "1")
    out = apply_opaque({"peers": [{"agent": "a1", "path": "src/auth.py",
                                  "symbol": "sign_in"}]})
    assert "auth" not in repr(out)
    assert out["peers"][0]["agent"] == "a1"
