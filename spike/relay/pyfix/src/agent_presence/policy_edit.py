"""Line-oriented writes to a policy file.

A policy people are expected to trust is a policy people read, so a config file
that comes back from `ap policy set` with the comments stripped and the keys
sorted is a config file nobody reads twice. Round-tripping through tomllib
would do exactly that. So this edits lines: it finds the key, changes the
value, and leaves every byte it did not have to touch alone.

`set` then `unset` gets you back the bytes you started with. That is the test
that keeps this honest.
"""

from __future__ import annotations

import json
import os
import re
from pathlib import Path

HEADER = (
    "# agent-presence policy. Saved is applied; nothing to restart.\n"
    "# Effects, quietest first: silent, notify, context, ask, deny.\n"
    "schema = 1\n"
)

_HEADER_RE = re.compile(r"^\s*(\[\[?)([^\]]*)(\]\]?)\s*(#.*)?$")
_KEY_RE = re.compile(r"^(\s*)([A-Za-z0-9_.\"'-]+)(\s*=\s*)(.*?)(\s*)(#.*)?$")


class EditError(ValueError):
    """The file is not something we can edit safely."""


def _unquote(raw: str) -> str:
    raw = raw.strip()
    if len(raw) >= 2 and raw[0] == raw[-1] and raw[0] in "\"'":
        body = raw[1:-1]
        if raw[0] == '"':
            try:
                return json.loads(raw)
            except ValueError:
                return body
        return body
    return raw


def _key_of(line: str) -> tuple[str, str] | None:
    """(key, value) for a `key = value` line, else None."""
    if not line.strip() or line.lstrip().startswith("#"):
        return None
    if _HEADER_RE.match(line):
        return None
    found = _KEY_RE.match(line.rstrip("\n"))
    if not found:
        return None
    return found.group(2).strip().strip("\"'"), found.group(4)


class _Section:
    __slots__ = ("name", "array", "header", "start", "end", "index")

    def __init__(self, name: str, array: bool, header: int, index: int) -> None:
        self.name = name
        self.array = array
        self.header = header  # index of the header line, -1 for the root table
        self.start = header + 1  # first body line
        self.end = header + 1  # one past the last body line
        self.index = index  # nth [[array]] with this name


def _sections(lines: list[str]) -> list[_Section]:
    out = [_Section("", False, -1, 0)]
    counts: dict[str, int] = {}
    for i, line in enumerate(lines):
        found = _HEADER_RE.match(line.rstrip("\n"))
        if not found:
            continue
        array = found.group(1) == "[["
        name = found.group(2).strip()
        out[-1].end = i
        counts[name] = counts.get(name, 0) + 1
        out.append(_Section(name, array, i, counts[name] - 1))
    out[-1].end = len(lines)
    return out


def _find_section(
    lines: list[str], name: str, *, array: bool, match: str | None
) -> _Section | None:
    for sec in _sections(lines):
        if sec.name != name or sec.array != array:
            continue
        if match is None:
            return sec
        for i in range(sec.start, sec.end):
            kv = _key_of(lines[i])
            if kv and kv[0] == "match" and _unquote(kv[1]) == match:
                return sec
    return None


def _find_key(lines: list[str], sec: _Section, key: str) -> int | None:
    for i in range(sec.start, sec.end):
        kv = _key_of(lines[i])
        if kv and kv[0] == key:
            return i
    return None


def _body_keys(lines: list[str], sec: _Section) -> list[str]:
    out = []
    for i in range(sec.start, sec.end):
        kv = _key_of(lines[i])
        if kv:
            out.append(kv[0])
    return out


def _body_has_comment(lines: list[str], sec: _Section) -> bool:
    return any(lines[i].lstrip().startswith("#") for i in range(sec.start, sec.end))


def _replace_value(line: str, value: str) -> str:
    """Keep the indentation, the spacing around `=` and any trailing comment."""
    found = _KEY_RE.match(line.rstrip("\n"))
    if not found:  # pragma: no cover - callers only pass matched lines
        return line
    indent, key, sep, _, gap, comment = found.groups()
    tail = (gap or "") + comment if comment else ""
    return f"{indent}{key}{sep}{value}{tail}\n"


def _section_names(is_floor: bool, path_rule: bool) -> tuple[str, bool]:
    if path_rule:
        return ("floor.path" if is_floor else "path"), True
    return ("floor" if is_floor else "effects"), False


def _atomic_write(path: Path, text: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(path.name + ".tmp")
    with open(tmp, "w", encoding="utf-8") as f:
        f.write(text)
        f.flush()
        os.fsync(f.fileno())
    os.chmod(tmp, 0o644)
    os.replace(tmp, path)


def _read(path: Path) -> tuple[list[str], bool]:
    try:
        text = path.read_text(encoding="utf-8")
    except FileNotFoundError:
        return [], False
    if text and not text.endswith("\n"):
        text += "\n"
    return text.splitlines(keepends=True), True


def set_effect(
    path: Path | str,
    *,
    rung: int,
    effect: str,
    match: str | None = None,
    is_floor: bool = False,
) -> str:
    """Write one rung. Returns "created", "added" or "changed"."""
    p = Path(path)
    lines, existed = _read(p)
    if not existed:
        lines = HEADER.splitlines(keepends=True)

    name, array = _section_names(is_floor, match is not None)
    key = f"rung{rung}"
    value = json.dumps(effect)

    sec = _find_section(lines, name, array=array, match=match)
    if sec is not None:
        at = _find_key(lines, sec, key)
        if at is not None:
            if _key_of(lines[at]) and _unquote(_key_of(lines[at])[1]) == effect:
                _atomic_write(p, "".join(lines))
                return "unchanged"
            lines[at] = _replace_value(lines[at], value)
            _atomic_write(p, "".join(lines))
            return "changed"
        insert = sec.end
        while insert > sec.start and not lines[insert - 1].strip():
            insert -= 1
        lines.insert(insert, f"{key} = {value}\n")
        _atomic_write(p, "".join(lines))
        return "added"

    block: list[str] = []
    if lines and lines[-1].strip():
        block.append("\n")
    block.append(f"[[{name}]]\n" if array else f"[{name}]\n")
    if match is not None:
        block.append(f"match = {json.dumps(match)}\n")
    block.append(f"{key} = {value}\n")
    lines.extend(block)
    _atomic_write(p, "".join(lines))
    return "created" if not existed else "added"


def unset_effect(
    path: Path | str,
    *,
    rung: int,
    match: str | None = None,
    is_floor: bool = False,
) -> bool:
    """Remove one rung. True when the file changed.

    A block left holding nothing but its own `match` is removed whole, and so
    is a section left holding nothing at all — otherwise `set` then `unset`
    would leave litter behind and the round trip would be a near miss.
    """
    p = Path(path)
    lines, existed = _read(p)
    if not existed:
        return False

    name, array = _section_names(is_floor, match is not None)
    sec = _find_section(lines, name, array=array, match=match)
    if sec is None:
        return False
    at = _find_key(lines, sec, f"rung{rung}")
    if at is None:
        return False

    del lines[at]
    sec = _find_section(lines, name, array=array, match=match)
    if sec is None:  # pragma: no cover - the section cannot vanish here
        _atomic_write(p, "".join(lines))
        return True

    remaining = [k for k in _body_keys(lines, sec) if k != "match"]
    if not remaining and not _body_has_comment(lines, sec) and sec.header >= 0:
        start = sec.header
        # Take the blank line the matching `set` would have inserted with it.
        if start > 0 and not lines[start - 1].strip():
            start -= 1
        del lines[start : sec.end]

    _atomic_write(p, "".join(lines))
    return True


def set_mode(path: Path | str, mode: str) -> str:
    """`mode` lives at the root table, so it needs its own small case."""
    p = Path(path)
    lines, existed = _read(p)
    if not existed:
        lines = HEADER.splitlines(keepends=True)

    root = _sections(lines)[0]
    at = _find_key(lines, root, "mode")
    value = json.dumps(mode)
    if at is not None:
        lines[at] = _replace_value(lines[at], value)
        _atomic_write(p, "".join(lines))
        return "changed"
    insert = root.end
    while insert > root.start and not lines[insert - 1].strip():
        insert -= 1
    lines.insert(insert, f"mode = {value}\n")
    _atomic_write(p, "".join(lines))
    return "created" if not existed else "added"
