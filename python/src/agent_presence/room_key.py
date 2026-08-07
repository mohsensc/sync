from __future__ import annotations

import hashlib
import re

_SCP = re.compile(r"^[^/@]+@([^:]+):(.+)$")
_PROTO = re.compile(r"^[a-z+]+://")
_USERINFO = re.compile(r"^[^/@]+@")


def normalize_remote(url: str) -> str:
    """Collapse any git remote URL form to canonical ``host/owner/repo``.

    Total by construction: unparseable input returns its trimmed, lowercased
    self, so two machines with the same odd remote still agree on a room.
    """
    s = url.strip().lower()

    scp = _SCP.match(s)
    if scp:
        s = f"{scp.group(1)}/{scp.group(2)}"
    else:
        s = _PROTO.sub("", s)
        s = _USERINFO.sub("", s)

    if s.endswith(".git"):
        s = s[: -len(".git")]
    return s.rstrip("/")


def room_id_from_remote(url: str) -> str:
    """Truncated sha256 of the normalized remote. The relay never learns the URL."""
    digest = hashlib.sha256(normalize_remote(url).encode()).hexdigest()
    return digest[:16]
