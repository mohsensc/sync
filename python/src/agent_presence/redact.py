from __future__ import annotations

import hashlib
import os

from .types import Region

# Anything here must never leave the machine. This is an allowlist boundary
# enforced as a denylist for defence in depth: the daemon builds payloads from
# known fields, and this strips anything that slipped through.
FORBIDDEN_FIELDS: frozenset[str] = frozenset(
    {
        "content", "contents", "text", "body",
        "diff", "patch",
        "prompt", "reasoning", "completion", "output", "stdout", "stderr",
        "env", "environment", "secrets", "token", "credentials",
    }
)

PERMITTED_TOP_LEVEL: frozenset[str] = frozenset(
    {"room", "human", "agent", "kind", "source", "verb", "region", "ts", "intent"}
)

# A permitted key is a permitted *name*, not a permitted value. Every one of
# these carries a scalar; anything else under that name is a container someone
# is using to smuggle payload past the allowlist, so it gets dropped whole.
_STRING_FIELDS: frozenset[str] = frozenset(
    {"room", "human", "agent", "kind", "source", "verb", "intent"}
)
_NUMBER_FIELDS: frozenset[str] = frozenset({"ts"})

# Set AGENT_PRESENCE_OPAQUE=1 to turn on org-level opaque mode.
OPAQUE_ENV = "AGENT_PRESENCE_OPAQUE"
_TRUTHY = frozenset({"1", "true", "yes", "on"})

# Marks a region that has already been hashed, so a second pass on the way out
# doesn't hash it again and desync it from every other client's copy.
OPAQUE_MARK = "opaque"


def opaque_enabled() -> bool:
    """Read the toggle per call. Flipping it shouldn't need a restart, and the
    cost is one dict lookup on a path that already does JSON."""
    return os.environ.get(OPAQUE_ENV, "").strip().lower() in _TRUTHY


def _is_str(value: object) -> bool:
    return isinstance(value, str)


def _is_number(value: object) -> bool:
    # bool is an int. A flag is not a timestamp.
    return isinstance(value, (int, float)) and not isinstance(value, bool)


def _is_line_no(value: object) -> bool:
    return isinstance(value, int) and not isinstance(value, bool)


def _clean_lines(value: object) -> list[int] | None:
    if isinstance(value, (list, tuple)) and len(value) == 2:
        if all(_is_line_no(v) for v in value):
            return [int(v) for v in value]
    return None


def _clean_region(value: object) -> dict | None:
    """A region is path + symbol + lines and nothing else. Returns None when
    there's no usable path, which drops the region rather than forwarding a
    half-parsed one."""
    if not isinstance(value, dict):
        return None
    path = value.get("path")
    if not _is_str(path):
        return None

    out: dict = {"path": path}
    symbol = value.get("symbol")
    if symbol is None or _is_str(symbol):
        out["symbol"] = symbol
    else:
        out["symbol"] = None
    out["lines"] = _clean_lines(value.get("lines"))
    return out


def redact(event_dict: dict) -> dict:
    """Strip everything not explicitly permitted, by name *and* by type.

    Name-only allowlisting leaks: a dict parked under a permitted key sails
    through and gets fanned out to every agent in the room. So each permitted
    key is validated to the scalar it's supposed to be, and the one nested
    structure we allow (region) is rebuilt field by field instead of copied.
    """
    if not isinstance(event_dict, dict):
        return {}

    out: dict = {}
    for key, value in event_dict.items():
        if key not in PERMITTED_TOP_LEVEL or key in FORBIDDEN_FIELDS:
            continue
        if key == "region":
            region = _clean_region(value)
            if region is not None:
                out["region"] = region
        elif key in _NUMBER_FIELDS:
            if _is_number(value):
                out[key] = value
        elif key in _STRING_FIELDS:
            if _is_str(value):
                out[key] = value

    if opaque_enabled():
        out = apply_opaque(out)
    return out


def _h(value: str) -> str:
    return hashlib.sha256(value.encode()).hexdigest()[:16]


def opaque_region(region: Region) -> Region:
    """Hash path and symbol client-side for orgs that enable opaque mode.

    Collision detection is equality on region keys, so it works identically on
    hashed input: the relay still arbitrates leases correctly while never
    learning a filename. Readability is lost; function is not.
    """
    return Region(
        path=_h(region.path),
        symbol=_h(region.symbol) if region.symbol is not None else None,
        lines=None,  # line ranges would narrow a hash back toward the original
    )


def opaque_region_if_enabled(region: Region) -> Region:
    return opaque_region(region) if opaque_enabled() else region


def apply_opaque(payload):
    """Walk a payload and hash every region-shaped dict in it.

    Region-shaped means 'has a string path'. That catches the nested
    `{"region": {...}}` form and the flattened path/symbol form the MCP tools
    return, without either side having to declare which is which.
    """
    if isinstance(payload, list):
        return [apply_opaque(v) for v in payload]
    if not isinstance(payload, dict):
        return payload

    out = {k: apply_opaque(v) for k, v in payload.items()}
    if not _is_str(out.get("path")) or out.get(OPAQUE_MARK) is True:
        return out

    out["path"] = _h(out["path"])
    if _is_str(out.get("symbol")):
        out["symbol"] = _h(out["symbol"])
    if "lines" in out:
        out["lines"] = None
    out[OPAQUE_MARK] = True
    return out


def opaque_outbound(payload: dict) -> dict:
    """Last stop before the wire. No-op unless opaque mode is on."""
    return apply_opaque(payload) if opaque_enabled() else payload
