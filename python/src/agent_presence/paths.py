"""Where the daemon's own files live, derived from its socket.

Ported from siblingPath in go/cmd/presenced/main.go. Two presenced sharing
one XDG_RUNTIME_DIR — the normal way to run one per repo — kept their
sockets apart (a taken unix socket fails loudly on bind) and then silently
shared one journal and one snapshot. Every reader that hangs a file off the
socket path has to derive it the same way the daemon does, or it just reads
whichever repo's file happened to get the fixed name first.

cli.py's Context and journal.py both call these instead of deriving their
own copy, so there is exactly one place this can drift from main.go.
"""

from __future__ import annotations

from pathlib import Path
from typing import Mapping

SOCK_ENV = "AGENT_PRESENCE_SOCK"
SNAPSHOT_ENV = "AGENT_PRESENCE_SNAPSHOT"
JOURNAL_ENV = "AGENT_PRESENCE_JOURNAL"

SOCK_NAME = "agent-presence.sock"
SNAPSHOT_SUFFIX = "json"
JOURNAL_SUFFIX = "decisions.jsonl"


def _stripped(env: Mapping[str, str], key: str) -> str:
    return (env.get(key) or "").strip()


def runtime_dir(env: Mapping[str, str]) -> Path:
    base = env.get("XDG_RUNTIME_DIR") or env.get("TMPDIR") or "/tmp"
    return Path(base)


def sock_path(env: Mapping[str, str]) -> Path:
    override = _stripped(env, SOCK_ENV)
    return Path(override) if override else runtime_dir(env) / SOCK_NAME


def sibling_path(sock: Path, suffix: str) -> Path:
    """main.go's siblingPath, byte for byte.

    Deliberately not Path.stem: pathlib treats a leading dot as "no
    extension" (`Path(".sock").stem == ".sock"`) and Go's filepath.Ext does
    not (it takes everything from the final dot, including one at index 0),
    so this walks the basename by hand instead of picking up that mismatch.
    """
    base = sock.name
    dot = base.rfind(".")
    stem = base if dot == -1 else base[:dot]
    if not stem:
        stem = "agent-presence"
    return sock.parent / f"{stem}.{suffix}"


def discover(configured: str, sock: Path, suffix: str) -> Path:
    """discoverJournalPath's precedence, generalized to any sibling file: an
    explicit override wins outright — an operator naming a path means it,
    room or no room — and only an unset override falls through to the
    socket-derived name."""
    configured = configured.strip() if configured else ""
    if configured:
        return Path(configured)
    return sibling_path(sock, suffix)


def snapshot_path(env: Mapping[str, str]) -> Path:
    return discover(env.get(SNAPSHOT_ENV, ""), sock_path(env), SNAPSHOT_SUFFIX)


def journal_path(env: Mapping[str, str]) -> Path:
    return discover(env.get(JOURNAL_ENV, ""), sock_path(env), JOURNAL_SUFFIX)
