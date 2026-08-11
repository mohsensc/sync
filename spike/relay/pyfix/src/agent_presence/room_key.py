from __future__ import annotations

import hashlib
import re

_SCP = re.compile(r"^[^/@]+@([^:]+):(.+)$")
_PROTO = re.compile(r"^[a-z+]+://")
_USERINFO = re.compile(r"^[^/@]+@")

# Trimming and case folding are ASCII-only, on purpose. The C++ daemon
# (cpp/daemon/repo.cpp) computes the same room id, and C++ has no Unicode case
# mapping in the standard library — str.lower() would fold "Ünicode" and C++
# would not, so one teammate's daemon and another's relay would land in
# different rooms. An explicit ASCII contract is worse normalization but it is
# the same normalization everywhere, which is the property that matters.
# 0x09-0x0d, 0x1c-0x1f and 0x20 are exactly the ASCII characters str.strip()
# would remove.
_ASCII_WS = "\t\n\x0b\x0c\r\x1c\x1d\x1e\x1f "
_ASCII_LOWER = str.maketrans(
    "ABCDEFGHIJKLMNOPQRSTUVWXYZ", "abcdefghijklmnopqrstuvwxyz"
)


def normalize_remote(url: str) -> str:
    """Collapse any git remote URL form to canonical ``host/owner/repo``.

    Total by construction: unparseable input returns its trimmed, lowercased
    self, so two machines with the same odd remote still agree on a room.

    Trim and case fold are ASCII-only so the C++ implementation can match byte
    for byte; see the note above.
    """
    s = url.strip(_ASCII_WS).translate(_ASCII_LOWER)

    scp = _SCP.match(s)
    if scp:
        s = f"{scp.group(1)}/{scp.group(2)}"
    else:
        s = _PROTO.sub("", s)
        s = _USERINFO.sub("", s)

    # Trailing slashes come off first: a remote copied out of a browser can
    # carry both, and ".git/" used to survive the suffix check and split one
    # repo into two rooms. Only one ".git" goes, so a repo actually named
    # "gitgit" or "api.github" keeps its name.
    s = s.rstrip("/")
    if s.endswith(".git"):
        s = s[: -len(".git")]
    return s.rstrip("/")


def room_id_from_remote(url: str) -> str:
    """Truncated sha256 of the normalized remote. The relay never learns the URL."""
    digest = hashlib.sha256(normalize_remote(url).encode()).hexdigest()
    return digest[:16]
