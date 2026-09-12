"""Priority tiers.

Four names, not an open integer range. An open range is an arms race — whoever
writes 101 wins — and nobody has to justify a number to anyone. Four names force
a conversation about which of four things a principal is.

``normal`` is the identity element. A room with no roster runs entirely at
``normal``, every comparison is a tie on tier, and arbitration falls back to
exactly what it did before priority existed.

Where a tier comes from is *not* here: see ``principals.py``. This module knows
the names and nothing about who is entitled to them, which is deliberate. A
claim frame can carry the string "critical" all day; it has to get past the
roster to become an integer.
"""

from __future__ import annotations

PRIORITY_NAMES: dict[str, int] = {
    "background": 0,
    "normal": 1,
    "elevated": 2,
    "critical": 3,
}

PRIORITY_MIN = 0
PRIORITY_NORMAL = 1
PRIORITY_MAX = 3

_BY_VALUE: dict[int, str] = {v: k for k, v in PRIORITY_NAMES.items()}


def name_of(priority: int) -> str:
    """The tier name, for the wire and for anything a human reads.

    An out-of-range integer is named for the tier it is clamped to rather than
    rendered raw, so nothing downstream has to cope with a name it has never
    seen. Clamping is also what ``clamp`` does to the value itself, so the name
    and the number never disagree.
    """
    return _BY_VALUE[clamp(priority)]


def clamp(priority: int) -> int:
    """Fold any integer into the four tiers."""
    return max(PRIORITY_MIN, min(PRIORITY_MAX, int(priority)))


def parse_priority(value: str | int) -> int:
    """A tier from a name or a number. Raises ValueError on anything else.

    This one *does* raise, unlike the policy parser. It is only ever called on
    a roster the relay operator wrote, where a typo should be reported loudly at
    startup rather than silently demoting somebody. The callers that need
    fail-open behaviour (``Roster.load``) catch it and record a problem.
    """
    if isinstance(value, bool):
        # bool is an int, and `unattended = true` under a tier key is a
        # different mistake that deserves a different message.
        raise ValueError(f"{value!r} is a boolean, not a priority tier")
    if isinstance(value, int):
        if value not in _BY_VALUE:
            raise ValueError(
                f"priority {value} is out of range; "
                f"expected 0..{PRIORITY_MAX} or one of "
                f"{', '.join(PRIORITY_NAMES)}"
            )
        return value
    if isinstance(value, str):
        name = value.strip().lower()
        if name in PRIORITY_NAMES:
            return PRIORITY_NAMES[name]
        raise ValueError(
            f"unknown priority tier {value!r}; "
            f"expected one of {', '.join(PRIORITY_NAMES)}"
        )
    raise ValueError(f"cannot read a priority tier from {value!r}")
