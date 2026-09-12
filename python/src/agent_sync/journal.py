"""Reader for the daemon's decision journal.

The daemon writes it: one JSON object per line, oldest first, truncated at a
cap so it cannot grow without bound. Nothing here writes. `ap why` reads it,
which is the whole point of it existing — a block you cannot get a reason for
is a block you stop trusting.

Tolerant on the way in. The daemon rewrites this file while we may be reading
it, so a torn last line is normal and is skipped, not raised.
"""

from __future__ import annotations

import json
import os
from dataclasses import dataclass
from pathlib import Path
from typing import Mapping

from . import paths as paths_mod

JOURNAL_MAX_LINES = 2000

_FIELDS = ("path", "agent", "holder", "human", "intent", "reason", "effect")


@dataclass(frozen=True)
class DecisionRecord:
    at_ms: int
    rung: int
    effect: str
    path: str = ""
    agent: str = ""
    holder: str = ""
    human: str = ""
    intent: str = ""
    reason: str = ""

    def as_dict(self) -> dict:
        return {
            "at_ms": self.at_ms,
            "rung": self.rung,
            "effect": self.effect,
            "path": self.path,
            "agent": self.agent,
            "holder": self.holder,
            "human": self.human,
            "intent": self.intent,
            "reason": self.reason,
        }


def journal_path(env: Mapping[str, str] | None = None) -> Path:
    """Same rule as the snapshot and the socket: derive it from the socket,
    let one var move it.

    `$AGENT_SYNC_JOURNAL` has to be read here as well as in the daemon,
    and so does `$AGENT_SYNC_SOCK` (see paths.py, ported from main.go's
    siblingPath) — two presenced sharing an XDG_RUNTIME_DIR is the normal
    way to run one per repo, and a reader that derives the journal from a
    fixed name instead of the socket reads the other repo's file.
    """
    env = os.environ if env is None else env
    return paths_mod.journal_path(env)


def parse_record(line: str) -> DecisionRecord | None:
    try:
        blob = json.loads(line)
    except ValueError:
        return None
    if not isinstance(blob, dict):
        return None
    rung = blob.get("rung")
    if not isinstance(rung, int) or isinstance(rung, bool):
        return None
    at = blob.get("at_ms", 0)
    if not isinstance(at, (int, float)) or isinstance(at, bool):
        at = 0
    fields = {
        name: blob[name] for name in _FIELDS
        if isinstance(blob.get(name), str)
    }
    fields.setdefault("effect", "")
    return DecisionRecord(at_ms=int(at), rung=rung, **fields)


def read_journal(
    path: Path | str | None = None,
    *,
    limit: int | None = 20,
    env: Mapping[str, str] | None = None,
) -> list[DecisionRecord]:
    """The last `limit` decisions, oldest first. An absent journal is an empty
    list, not an error: a daemon that has decided nothing yet is the normal
    state of a fresh machine.

    `limit=None` reads the whole file. `limit=0` reads nothing, and so does any
    negative, which is worth being explicit about: this used to say
    `if limit > 0`, and `lines[-0:]` is the entire list, so asking for none
    printed everything and asking for -1 printed everything too. A count you
    typed and a count you got have to be the same number.
    """
    if limit is not None and limit <= 0:
        return []

    p = Path(path) if path is not None else journal_path(env)
    try:
        with open(p, "r", encoding="utf-8", errors="replace") as f:
            lines = f.readlines()
    except OSError:
        return []

    if limit is not None:
        lines = lines[-limit:]
    out: list[DecisionRecord] = []
    for line in lines:
        line = line.strip()
        if not line:
            continue
        record = parse_record(line)
        if record is not None:
            out.append(record)
    return out
