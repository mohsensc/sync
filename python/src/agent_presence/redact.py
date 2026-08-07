from __future__ import annotations

import hashlib

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


def redact(event_dict: dict) -> dict:
    """Strip everything not explicitly permitted, then strip forbidden keys
    from any surviving nested dict."""
    out = {k: v for k, v in event_dict.items() if k in PERMITTED_TOP_LEVEL}

    region = out.get("region")
    if isinstance(region, dict):
        out["region"] = {
            k: v for k, v in region.items()
            if k in {"path", "symbol", "lines"} and k not in FORBIDDEN_FIELDS
        }
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
