from __future__ import annotations

import pytest

from agent_sync.priority import PRIORITY_MAX, PRIORITY_NAMES, parse_priority


# #95: go's ParsePriority used to fall back to strconv.Atoi, so a quoted
# numeral in principals.toml (attended = "3") parsed as a tier there and as
# unknown here — the same roster line meant "critical" to gorelay and
# "default" to ap. Names are the documented interface
# (docs/policy-design.md §4 has no numeral example); go's numeral fallback
# was removed rather than added here. This case list is mirrored exactly in
# go/internal/relaysrv/priority_test.go::TestParsePriorityParity — same
# inputs, same order — so the two sides can't quietly drift apart again.
PARITY_CASES = [
    ("background", PRIORITY_NAMES["background"], None),
    ("normal", PRIORITY_NAMES["normal"], None),
    ("elevated", PRIORITY_NAMES["elevated"], None),
    ("critical", PRIORITY_NAMES["critical"], None),
    (" Critical ", PRIORITY_NAMES["critical"], None),
    ("NORMAL", PRIORITY_NAMES["normal"], None),
    ("1", None, "unknown priority tier '1'"),
    ("7", None, "unknown priority tier '7'"),
    ("elevatd", None, "unknown priority tier 'elevatd'"),
    ("", None, "unknown priority tier ''"),
]


@pytest.mark.parametrize("value,want,want_err", PARITY_CASES)
def test_parse_priority_parity(value, want, want_err):
    if want_err is None:
        assert parse_priority(value) == want
    else:
        with pytest.raises(ValueError, match=want_err):
            parse_priority(value)


def test_parse_priority_accepts_a_bare_toml_integer():
    # The one place a bare number is still a tier: an actual int, the way
    # tomllib hands back an unquoted `attended = 3`, never a str that
    # merely looks numeric.
    assert parse_priority(3) == PRIORITY_MAX


def test_parse_priority_rejects_an_out_of_range_bare_integer():
    with pytest.raises(ValueError, match=r"priority 7 is out of range"):
        parse_priority(7)


def test_parse_priority_rejects_a_bool():
    with pytest.raises(ValueError, match="is a boolean, not a priority tier"):
        parse_priority(True)
