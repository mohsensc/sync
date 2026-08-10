"""`ap` — the terminal surface for agent-presence.

No slash commands and no TUI, on purpose. A TUI is for exploring and for
per-session tweaking, and there is nothing to watch at 3am while the agents
run; the state outlives the terminal session, so the state is a file you can
diff, review and read in one screen. This binary is the verb surface over that
file, plus the two questions you actually ask when something stops you: what is
my policy, and why did that happen.

Everything here reads or writes config. None of it is reachable by the agent
that got blocked — that is the MCP surface, and it is read-only, because an
agent that can turn blocking off is a loop with no damping.

Exit codes: 0 fine, 1 something is degraded or invalid, 2 you typed it wrong.
"""

from __future__ import annotations

import argparse
import datetime as dt
import json
import logging
import os
import re
import socket
import sys
import tomllib
from dataclasses import dataclass
from pathlib import Path
from typing import Callable, Mapping, Sequence, TextIO

from . import journal as journal_mod
from . import policy as policy_mod
from . import policy_edit
from . import principals as principals_mod
from .policy import (
    EFFECTS,
    FLOOR_LAYERS,
    LAYER_ORDER,
    MODES,
    RANK,
    RUNGS,
    SCHEMA_VERSION,
    Layer,
    Policy,
    Resolution,
)
from .principals import Roster, hash_token, mint_token
from .priority import PRIORITY_NAMES, name_of, parse_priority

OK, PROBLEM, USAGE = 0, 1, 2

REPO_ENV = "AGENT_PRESENCE_REPO_ROOT"
SOCK_ENV = "AGENT_PRESENCE_SOCK"
SNAPSHOT_ENV = "AGENT_PRESENCE_SNAPSHOT"
ROSTER_ENV = "AGENT_PRESENCE_PRINCIPALS"
ROSTER_RELPATH = ".agent-presence/principals.toml"

# Every layer, for looking at. `compile` deliberately uses a shorter list: the
# org floor reaches the daemon from the relay, not from a file on this disk.
ALL_LAYERS: tuple[str, ...] = LAYER_ORDER
EDITABLE_LAYERS: tuple[str, ...] = ("user", "session", "repo", "org")

SNAPSHOT_NAME = "agent-presence.json"
SOCK_NAME = "agent-presence.sock"


# -- colour -----------------------------------------------------------------


class Ink:
    """ANSI when a human is looking, nothing at all when they are not.

    `ap policy show --json | jq` and `ap doctor > log` have to stay clean, so
    the default is auto and the test is on the stream about to be written.
    """

    CODES = {
        "bold": "1", "dim": "2", "red": "31", "green": "32",
        "yellow": "33", "blue": "34", "cyan": "36",
    }
    EFFECT_STYLE = {
        "silent": "dim", "notify": "cyan", "context": "blue",
        "ask": "yellow", "deny": "red",
    }

    def __init__(self, enabled: bool) -> None:
        self.enabled = enabled

    @classmethod
    def decide(cls, mode: str, stream: TextIO, env: Mapping[str, str]) -> "Ink":
        if mode == "always":
            return cls(True)
        if mode == "never" or env.get("NO_COLOR") or env.get("TERM", "") == "dumb":
            return cls(False)
        return cls(bool(getattr(stream, "isatty", lambda: False)()))

    def paint(self, style: str, text: str) -> str:
        code = self.CODES.get(style)
        if not self.enabled or code is None or not text:
            return text
        return f"\033[{code}m{text}\033[0m"

    def bold(self, text: str) -> str:
        return self.paint("bold", text)

    def dim(self, text: str) -> str:
        return self.paint("dim", text)

    def red(self, text: str) -> str:
        return self.paint("red", text)

    def green(self, text: str) -> str:
        return self.paint("green", text)

    def yellow(self, text: str) -> str:
        return self.paint("yellow", text)

    def effect(self, name: str) -> str:
        return self.paint(self.EFFECT_STYLE.get(name, "bold"), name)


class Out:
    """One place that knows which stream a line belongs on, so no command has
    to remember and `--json` cannot end up interleaved with prose."""

    def __init__(self, stdout: TextIO, stderr: TextIO, ink: Ink) -> None:
        self.stdout = stdout
        self.stderr = stderr
        self.ink = ink

    def say(self, line: str = "") -> None:
        print(line, file=self.stdout)

    def error(self, line: str) -> None:
        print(f"ap: {line}", file=self.stderr)

    def json(self, blob: object) -> None:
        print(json.dumps(blob, indent=2, sort_keys=True), file=self.stdout)

    def table(self, headers: Sequence[str], rows: Sequence[Sequence[str]],
              *, plain: Sequence[Sequence[str]] | None = None,
              indent: str = "  ") -> None:
        """`plain` is the same grid without colour, used only to size columns:
        escape codes are bytes the terminal never shows but ljust counts."""
        grid = list(plain if plain is not None else rows)
        widths = [len(h) for h in headers]
        for row in grid:
            for i, cell in enumerate(row):
                widths[i] = max(widths[i], len(cell))
        header = "  ".join(h.ljust(widths[i]) for i, h in enumerate(headers))
        self.say(indent + self.ink.dim(header.rstrip()))
        for n, row in enumerate(rows):
            cells = [
                cell + " " * max(widths[i] - len(grid[n][i]), 0)
                for i, cell in enumerate(row)
            ]
            self.say(indent + "  ".join(cells).rstrip())


# -- context ----------------------------------------------------------------


def find_repo_root(start: Path, env: Mapping[str, str]) -> Path | None:
    """`$AGENT_PRESENCE_REPO_ROOT`, else the nearest ancestor holding `.git`.

    No subprocess. `ap` gets run from prompts and hooks; shelling out to git to
    answer something three stat calls can answer is latency paid every time.
    """
    override = env.get(REPO_ENV, "").strip()
    if override:
        return Path(override)
    here = start.resolve()
    for candidate in (here, *here.parents):
        if (candidate / ".git").exists():
            return candidate
    return None


class Context:
    def __init__(self, args: argparse.Namespace, out: Out,
                 env: Mapping[str, str], cwd: Path) -> None:
        self.args = args
        self.out = out
        self.env = env
        self.cwd = cwd
        self.repo_root = find_repo_root(cwd, env)

    def policy(self, include: Sequence[str] = ALL_LAYERS) -> Policy:
        return policy_mod.discover(
            str(self.repo_root) if self.repo_root else None,
            env=self.env,
            include=tuple(include),  # type: ignore[arg-type]
        )

    def client_policy(self) -> Policy:
        """What the daemon on this machine resolves. No org layer: the relay
        pushes the org floor over the wire, so reading /etc here would count
        it twice on the relay host and not at all anywhere else."""
        return self.policy(policy_mod.DEFAULT_INCLUDE)

    def layer_file(self, name: str) -> Path | None:
        if name == "builtin":
            return None
        if name == "org":
            return policy_mod.org_policy_path(self.env)
        if name == "repo":
            if self.repo_root is None:
                return None
            return policy_mod.repo_policy_path(str(self.repo_root), self.env)
        if name == "user":
            return policy_mod.user_policy_path(self.env)
        if name == "session":
            return policy_mod.session_policy_path(self.env)
        return None

    def roster_path(self) -> Path | None:
        override = self.env.get(ROSTER_ENV, "").strip()
        if override:
            return Path(override)
        if self.repo_root is None:
            return None
        return self.repo_root / ROSTER_RELPATH

    def unattended(self, flag: bool = False) -> bool:
        """Whether this run has a human on the other end of an `ask`.

        `--unattended` forces it on and `$AGENT_PRESENCE_UNATTENDED` turns it
        on, and the env var is the one that matters: the case the promotion
        exists for is an agent launched by a script, and a script does not pass
        `ap` a flag. Only the flag was read before, so the exec path — the
        whole point of the feature — never promoted anything, and `ap doctor`
        said `ok` over a cache holding `ask` for a run with nobody to ask.

        Nothing turns it off. It can only ever tighten, so there is no reason
        to be able to, and a switch that says "there is a human here" when
        there is not is the failure this is meant to prevent.
        """
        return bool(flag) or principals_mod.unattended_flag(self.env)

    def runtime_dir(self) -> Path:
        base = self.env.get("XDG_RUNTIME_DIR") or self.env.get("TMPDIR") or "/tmp"
        return Path(base)

    def snapshot_path(self) -> Path:
        override = self.env.get(SNAPSHOT_ENV, "").strip()
        return Path(override) if override else self.runtime_dir() / SNAPSHOT_NAME

    def sock_path(self) -> Path:
        override = self.env.get(SOCK_ENV, "").strip()
        return Path(override) if override else self.runtime_dir() / SOCK_NAME


# -- validation with line numbers -------------------------------------------
#
# `policy.parse_layer` is the loader: it never raises, falls every bad field
# back to its default and records one line of prose. That is exactly right for
# a decision path and useless for fixing a file, because it cannot tell you
# where the bad field was. So `ap policy check` re-reads the text and locates
# things. The vocabulary — which effects exist, which layers honour a floor,
# what schema we are on — is imported from `policy`, never restated here, so
# the two cannot drift on the part that matters.

ROOT_KEYS = frozenset({"schema", "mode", "effects", "path", "floor"})
_RUNG_KEY = re.compile(r"rung([0-4])\Z")
_QUIET_RUNGS = (0, 1, 2)


@dataclass(frozen=True)
class Finding:
    line: int  # 0 when we could not place it
    severity: str  # "error" | "warning"
    message: str

    def render(self, source: str) -> str:
        where = f"{source}:{self.line}" if self.line else source
        return f"{where}: {self.message}"


def _line_index(text: str) -> dict[tuple[str, str | None], int]:
    """Where each key sits. Understands bare keys under `[table]` and
    `[[array]]` headers, which is the whole of the policy schema."""
    out: dict[tuple[str, str | None], int] = {}
    current = ""
    counts: dict[str, int] = {}
    for lineno, raw in enumerate(text.splitlines(), start=1):
        line = raw.strip()
        if not line or line.startswith("#"):
            continue
        if line.startswith("[["):
            end = line.find("]]")
            if end == -1:
                continue
            name = line[2:end].strip()
            counts[name] = counts.get(name, 0) + 1
            current = f"{name}[{counts[name] - 1}]"
            out.setdefault((current, None), lineno)
            continue
        if line.startswith("["):
            end = line.find("]")
            if end == -1:
                continue
            current = line[1:end].strip()
            out.setdefault((current, None), lineno)
            continue
        key, sep, _ = line.partition("=")
        if sep:
            out.setdefault((current, key.strip().strip("\"'")), lineno)
    return out


def _decode_line(exc: BaseException) -> int:
    lineno = getattr(exc, "lineno", None)
    if isinstance(lineno, int):
        return lineno
    found = re.search(r"at line (\d+)", str(exc))
    return int(found.group(1)) if found else 0


def _check_rung_table(
    table: Mapping[str, object],
    *,
    section: str,
    index: Mapping[tuple[str, str | None], int],
    label: str,
    out: list[Finding],
) -> dict[int, str]:
    found: dict[int, str] = {}
    for key, value in table.items():
        at = index.get((section, key)) or index.get((section, None)) or 0
        match = _RUNG_KEY.fullmatch(str(key))
        if match is None:
            out.append(Finding(
                at, "error",
                f"{label}: unknown key {key!r}; expected rung0..rung4",
            ))
            continue
        if not isinstance(value, str) or value not in RANK:
            out.append(Finding(
                at, "error",
                f"{label}: {key} = {value!r} is not one of "
                f"{', '.join(EFFECTS)}; falling back to the default",
            ))
            continue
        rung = int(match.group(1))
        found[rung] = value
        if rung in _QUIET_RUNGS and RANK[value] >= RANK["ask"]:
            out.append(Finding(
                at, "warning",
                f"{label}: {key} = {value!r} interrupts. Rungs 0-2 are quiet "
                f"under every shipped default; this is allowed, just make sure "
                f"you meant it",
            ))
    return found


def lint_policy_text(text: str, *, layer_name: str) -> list[Finding]:
    """Every problem in one policy file, with the line it is on."""
    out: list[Finding] = []
    index = _line_index(text)

    try:
        data = tomllib.loads(text)
    except Exception as exc:  # tomllib raises TOMLDecodeError; be total
        return [Finding(_decode_line(exc), "error", f"not valid TOML: {exc}")]

    for key in data:
        if key not in ROOT_KEYS:
            out.append(Finding(
                index.get(("", key), 0), "warning",
                f"unknown top-level key {key!r}; ignored",
            ))

    schema = data.get("schema", SCHEMA_VERSION)
    if schema != SCHEMA_VERSION:
        out.append(Finding(
            index.get(("", "schema"), 0), "error",
            f"schema = {schema!r}, expected {SCHEMA_VERSION}; "
            f"read as schema {SCHEMA_VERSION}",
        ))

    mode = data.get("mode", "normal")
    if mode not in MODES:
        out.append(Finding(
            index.get(("", "mode"), 0), "error",
            f"mode = {mode!r} is not one of {', '.join(MODES)}; using normal",
        ))
        mode = "normal"

    rule_count = 0
    effects = data.get("effects")
    if effects is not None:
        if not isinstance(effects, dict):
            out.append(Finding(index.get(("effects", None), 0), "error",
                               "[effects] must be a table; ignored"))
        else:
            got = _check_rung_table(effects, section="effects", index=index,
                                    label="[effects]", out=out)
            rule_count += 1 if got else 0

    rule_count += _lint_path_rules(
        data.get("path"), index=index, header="path", is_floor=False, out=out
    )

    floor = data.get("floor")
    if floor is not None:
        at = index.get(("floor", None), 0)
        if layer_name not in FLOOR_LAYERS:
            out.append(Finding(
                at, "error",
                f"[floor] is only honoured in the org and repo layers; "
                f"ignored in the {layer_name} layer",
            ))
        elif not isinstance(floor, dict):
            out.append(Finding(at, "error", "[floor] must be a table; ignored"))
        else:
            _check_rung_table(
                {k: v for k, v in floor.items() if k != "path"},
                section="floor", index=index, label="[floor]", out=out,
            )
            _lint_path_rules(
                floor.get("path"), index=index, header="floor.path",
                is_floor=True, out=out,
            )

    if mode == "observer" and rule_count == 0:
        # The ceiling is applied to the layer that wins a rung. A layer with no
        # effect rules never wins one, so this file caps nothing. Worth saying:
        # a one-word file that quietly does nothing is the worst kind.
        out.append(Finding(
            index.get(("", "mode"), 0), "warning",
            'mode = "observer" caps this layer at notify, but this layer sets '
            "no effects, so it never wins a rung and the cap never applies. "
            "Add an [effects] block for the rungs you want capped",
        ))

    out.extend(_tie_findings(data, index))
    return out


def _lint_path_rules(
    entries: object,
    *,
    index: Mapping[tuple[str, str | None], int],
    header: str,
    is_floor: bool,
    out: list[Finding],
) -> int:
    label = f"[[{header}]]"
    if entries is None:
        return 0
    at_block = index.get((f"{header}[0]", None), 0)
    if not isinstance(entries, list):
        out.append(Finding(at_block, "error",
                           f"{label} must be an array of tables; ignored"))
        return 0

    kept = 0
    for i, entry in enumerate(entries):
        section = f"{header}[{i}]"
        at = index.get((section, None), 0)
        if not isinstance(entry, dict):
            out.append(Finding(at, "error", f"{label}[{i}] must be a table; ignored"))
            continue
        match = entry.get("match")
        if not isinstance(match, str) or not match:
            out.append(Finding(at, "error",
                               f"{label}[{i}] has no usable `match` glob; ignored"))
            continue
        if not policy_mod.valid_glob(match):
            out.append(Finding(
                index.get((section, "match"), at), "error",
                f"{label}[{i}]: {match!r} is not a valid glob; ignored",
            ))
            continue
        got = _check_rung_table(
            {k: v for k, v in entry.items() if k != "match"},
            section=section, index=index, label=f"{label} {match}", out=out,
        )
        if got:
            kept += 1
        else:
            out.append(Finding(
                at, "warning",
                f"{label}[{i}] {match!r} sets no rungs; it does nothing",
            ))
    return kept


def _tie_findings(
    data: Mapping[str, object], index: Mapping[tuple[str, str | None], int]
) -> list[Finding]:
    """Two rules with the same literal prefix claiming one rung. Which of them
    wins is a detail of file order nobody meant to rely on."""
    out: list[Finding] = []
    entries = data.get("path")
    if not isinstance(entries, list):
        return out
    seen: dict[tuple[int, int], str] = {}
    for i, entry in enumerate(entries):
        if not isinstance(entry, dict):
            continue
        match = entry.get("match")
        if not isinstance(match, str) or not match:
            continue
        rule = policy_mod.Rule(match=match, effects={}, is_floor=False, order=i)
        for key in entry:
            found = _RUNG_KEY.fullmatch(str(key))
            if found is None:
                continue
            rung = int(found.group(1))
            slot = (rung, rule.specificity())
            first = seen.get(slot)
            if first is not None and first != match:
                out.append(Finding(
                    index.get((f"path[{i}]", key), 0), "warning",
                    f"rung{rung} is claimed by both {first!r} and {match!r} at "
                    f"the same specificity; the later one wins",
                ))
            seen[slot] = match
    return out


# -- rendering --------------------------------------------------------------


LayerRow = tuple[str, "Layer | None", "Path | None"]


def _layers_view(ctx: Context, pol: Policy) -> list[LayerRow]:
    """Every layer in authority order, present or not. `discover` drops absent
    files entirely, and "there is no file there" is a thing people need told."""
    out = []
    for name in ALL_LAYERS:
        out.append((name, pol.layer(name), ctx.layer_file(name)))
    return out


def _source_of(name: str, layer: Layer | None, path: Path | None) -> str:
    if layer is not None:
        return layer.source
    if name == "builtin":
        return "<builtin>"
    if path is None:
        return "(no file)"
    return f"{path} (absent)"


def _resolution_json(res: Resolution) -> dict:
    return {
        "rung": res.rung,
        "path": res.path,
        "effect": res.effect,
        "base": res.base,
        "layer": res.winning_layer,
        "rule": res.winning_rule,
        "source": res.source,
        "ceiling": res.ceiling,
        "floor": res.floor,
        "floor_layer": res.floor_layer,
        "unattended_promoted": res.unattended_promoted,
        "reason": res.reason(),
    }


def _layer_json(layer: Layer) -> dict:
    return {
        "name": layer.name,
        "source": layer.source,
        "mode": layer.mode,
        "parsed": layer.parsed,
        "rules": [
            {
                "match": rule.match,
                "floor": rule.is_floor,
                "effects": {f"rung{k}": v for k, v in sorted(rule.effects.items())},
            }
            for rule in layer.rules
        ],
        "problems": list(layer.problems),
    }


def _print_effective(ctx: Context, pol: Policy, path: str, unattended: bool) -> None:
    out, ink = ctx.out, ctx.out.ink
    where = path or "any path"
    supervision = "unattended" if unattended else "attended"
    out.say(f"{ink.bold('effective policy')}  {where}  ({supervision})")
    out.say()

    rows: list[list[str]] = []
    plain: list[list[str]] = []
    for rung in RUNGS:
        res = pol.resolve(rung, path, unattended=unattended)
        ceiling = res.ceiling or "-"
        floor = f"{res.floor} ({res.floor_layer or 'builtin'})"
        rows.append([str(rung), ink.effect(res.effect), res.winning_layer,
                     res.winning_rule, ceiling, floor, res.source])
        plain.append([str(rung), res.effect, res.winning_layer,
                      res.winning_rule, ceiling, floor, res.source])
    out.table(["rung", "effect", "from", "rule", "ceiling", "floor", "source"],
              rows, plain=plain)

    out.say()
    out.say(f"{ink.bold('layers')}  least authority first")
    lrows = []
    for name, layer, file in _layers_view(ctx, pol):
        note = layer.mode if layer is not None and layer.mode != "normal" else ""
        lrows.append([name, _source_of(name, layer, file), note])
    out.table(["layer", "source", ""], lrows)

    if pol.problems:
        out.say()
        out.say(ink.red(f"{len(pol.problems)} problem(s) — policy is degraded. "
                        "Run `ap policy check`."))


# -- policy show ------------------------------------------------------------


def cmd_policy_show(ctx: Context) -> int:
    args, out = ctx.args, ctx.out
    pol = ctx.policy()
    path = args.path or ""
    unattended = ctx.unattended(args.unattended)

    if args.layer:
        layer = pol.layer(args.layer)
        file = ctx.layer_file(args.layer)
        if layer is None:
            if args.json:
                out.json({"name": args.layer, "present": False,
                          "source": _source_of(args.layer, None, file),
                          "rules": [], "problems": []})
                return OK
            out.say(ctx.out.ink.dim(
                f"{args.layer}: {_source_of(args.layer, None, file)} — "
                "nothing set, so the layers below it decide"
            ))
            return OK
        if args.json:
            out.json({**_layer_json(layer), "present": True})
            return OK
        _show_one_layer(ctx, layer)
        return OK

    if args.json:
        out.json({
            "path": path,
            "unattended": unattended,
            "digest": pol.digest,
            "degraded": pol.degraded,
            "table": pol.table_for(path, unattended=unattended).names(),
            "floor": pol.floor_table(path).names(),
            "rungs": [
                _resolution_json(pol.resolve(r, path, unattended=unattended))
                for r in RUNGS
            ],
            "layers": [_layer_json(lyr) for lyr in pol.layers],
            "problems": list(pol.problems),
        })
        return OK

    if args.effective:
        _print_effective(ctx, pol, path, unattended)
        return OK

    _show_stack(ctx, pol)
    return OK


def _show_one_layer(ctx: Context, layer: Layer) -> None:
    out, ink = ctx.out, ctx.out.ink
    out.say(f"{ink.bold(layer.name)}  {layer.source}")
    out.say(f"  mode {layer.mode}")
    if not layer.rules:
        out.say(ink.dim("  no rules"))
    for rule in layer.rules:
        kind = "floor " if rule.is_floor else "effect"
        effects = " ".join(
            f"rung{k}={ink.effect(v)}" for k, v in sorted(rule.effects.items())
        )
        out.say(f"  {kind} {rule.describe():<24}{effects}")
    for line in layer.problems:
        out.say(ink.red(f"  problem  {line}"))


def _show_stack(ctx: Context, pol: Policy) -> None:
    out, ink = ctx.out, ctx.out.ink
    out.say(f"{ink.bold('policy layers')}  least authority first")
    out.say()
    for name, layer, file in _layers_view(ctx, pol):
        if layer is None:
            out.say(f"{ink.bold(name)}  {ink.dim(_source_of(name, None, file))}")
            out.say()
            continue
        _show_one_layer(ctx, layer)
        out.say()
    out.say(ink.dim("ap policy show --effective   what these actually resolve to"))


# -- policy path ------------------------------------------------------------


def cmd_policy_path(ctx: Context) -> int:
    out, name = ctx.out, ctx.args.layer
    path = ctx.layer_file(name)
    if path is None:
        if name == "repo":
            out.error("not inside a git repo, so there is no repo layer")
        else:
            out.error("no session policy file; "
                      "point $AGENT_PRESENCE_POLICY at one first")
        return PROBLEM
    out.say(str(path))
    return OK


# -- policy set / unset -----------------------------------------------------


def _rung_number(key: str) -> int:
    if not key.startswith("rung") or not key[4:].isdigit():
        raise ValueError(f"{key!r} is not a rung; use rung0 through rung4")
    rung = int(key[4:])
    if rung not in RUNGS:
        raise ValueError(f"rung {rung} does not exist; rungs are 0 through 4")
    return rung


def _writable_layer(ctx: Context, name: str) -> Path | None:
    path = ctx.layer_file(name)
    if path is not None:
        return path
    if name == "repo":
        ctx.out.error("not inside a git repo, so there is no repo layer to write")
    else:
        ctx.out.error("the session layer has no file; "
                      "point $AGENT_PRESENCE_POLICY at a path first")
    return None


def cmd_policy_set(ctx: Context) -> int:
    args, out = ctx.args, ctx.out
    key, sep, value = args.assignment.partition("=")
    if not sep:
        out.error(f"expected KEY=VALUE, got {args.assignment!r}")
        return USAGE
    key, value = key.strip(), value.strip()

    path = _writable_layer(ctx, args.layer)
    if path is None:
        return PROBLEM

    if key == "mode":
        if value not in MODES:
            out.error(f"mode must be one of {', '.join(MODES)}")
            return USAGE
        what = policy_edit.set_mode(path, value)
        out.say(f"{what} mode = {value} in {path}")
        return OK

    try:
        rung = _rung_number(key)
    except ValueError as exc:
        out.error(str(exc))
        return USAGE
    if value not in RANK:
        out.error(f"{value!r} is not an effect; quietest first: {', '.join(EFFECTS)}")
        return USAGE
    if args.floor and args.layer not in FLOOR_LAYERS:
        out.error(
            f"floors are only honoured in the org and repo layers. A [floor] in "
            f"the {args.layer} layer parses and is ignored, so this would be a "
            f"no-op; write it as a plain effect instead"
        )
        return PROBLEM

    what = policy_edit.set_effect(
        path, rung=rung, effect=value, match=args.path, is_floor=args.floor
    )
    scope = f"{args.path} " if args.path else ""
    kind = "floor " if args.floor else ""
    out.say(f"{what} {kind}{scope}rung{rung} = {value} in {path}")
    after = ctx.policy().resolve(rung, args.path or "")
    out.say(ctx.out.ink.dim(f"  now: {after.reason()}"))
    return OK


def cmd_policy_unset(ctx: Context) -> int:
    args, out = ctx.args, ctx.out
    try:
        rung = _rung_number(args.key.strip())
    except ValueError as exc:
        out.error(str(exc))
        return USAGE

    path = _writable_layer(ctx, args.layer)
    if path is None:
        return PROBLEM

    if policy_edit.unset_effect(path, rung=rung, match=args.path,
                                is_floor=args.floor):
        out.say(f"removed rung{rung} from {path}")
    else:
        out.say(f"nothing to remove: rung{rung} is not set in {path}")
    after = ctx.policy().resolve(rung, args.path or "")
    out.say(ctx.out.ink.dim(f"  now: {after.reason()}"))
    return OK


# -- policy check -----------------------------------------------------------


def _lint_layer(ctx: Context, name: str, layer: Layer | None,
                file: Path | None) -> tuple[list[Finding], list[str]]:
    """Findings with line numbers, plus any loader problem the linter did not
    account for. The second list should always be empty; printing it when it is
    not is how the two stay honest with each other."""
    if file is None or layer is None:
        return [], list(layer.problems) if layer else []
    try:
        text = file.read_text(encoding="utf-8")
    except OSError:
        return [], list(layer.problems)

    findings = lint_policy_text(text, layer_name=name)
    errors = [f for f in findings if f.severity == "error"]
    unaccounted = [] if len(errors) >= len(layer.problems) else list(layer.problems)
    return findings, unaccounted


def cmd_policy_check(ctx: Context) -> int:
    args, out, ink = ctx.args, ctx.out, ctx.out.ink
    pol = ctx.policy()
    view = [row for row in _layers_view(ctx, pol)
            if not args.layer or row[0] == args.layer]

    results = []
    for name, layer, file in view:
        findings, unaccounted = _lint_layer(ctx, name, layer, file)
        results.append((name, layer, file, findings, unaccounted))

    failed = sum(
        1 for _, layer, _, findings, extra in results
        if any(f.severity == "error" for f in findings) or extra
        or (layer is not None and not layer.parsed)
    )

    if args.json:
        out.json({
            "degraded": bool(failed),
            "layers": [
                {
                    "name": name,
                    "source": _source_of(name, layer, file),
                    "present": layer is not None,
                    "findings": [
                        {"line": f.line, "severity": f.severity,
                         "message": f.message}
                        for f in findings
                    ],
                    "unaccounted": extra,
                }
                for name, layer, file, findings, extra in results
            ],
        })
        return PROBLEM if failed else OK

    for name, layer, file, findings, extra in results:
        errors = [f for f in findings if f.severity == "error"]
        warnings = [f for f in findings if f.severity == "warning"]
        if errors or extra:
            mark = ink.red("FAIL")
        elif warnings:
            mark = ink.yellow("warn")
        elif layer is None:
            mark = ink.dim("none")
        else:
            mark = ink.green("ok  ")
        out.say(f"{mark}  {name:<9}{_source_of(name, layer, file)}")
        source = str(file) if file else name
        for finding in errors + warnings:
            paint = ink.red if finding.severity == "error" else ink.yellow
            out.say(f"      {paint(finding.render(source))}")
        for line in extra:
            out.say(f"      {ink.red(line)}  [loader]")

    out.say()
    if failed:
        out.say(ink.red(
            f"{failed} layer(s) degraded. Anything they were meant to change "
            "falls back to the builtin table; nothing drops below the builtin "
            "floor, so rung 3 still reaches you."
        ))
        return PROBLEM
    out.say(ink.green("every layer parses"))
    return OK


# -- policy compile ---------------------------------------------------------


def _rule_lines(blob: dict, ink: Ink) -> list[str]:
    """The path rules in the cache, as they will be read. Printed because a
    rule you cannot see is a rule you cannot check."""
    lines = []
    for kind, key in (("", "rules"), ("floor ", "floors")):
        for entry in blob.get(key, []):
            if not entry.get("match"):
                continue  # the blanket rules are the table printed above
            effects = " ".join(
                f"rung{i}={ink.effect(e)}"
                for i, e in enumerate(entry["effects"]) if e
            )
            label = f"{kind}{entry['match']}"
            lines.append(f"  {label:<30}{effects}  {ink.dim(entry['layer'])}")
    return lines


def cmd_policy_compile(ctx: Context) -> int:
    args, out, ink = ctx.args, ctx.out, ctx.out.ink
    pol = ctx.client_policy()
    unattended = ctx.unattended(args.unattended)
    blob = policy_mod.compile_runtime(
        pol, path=args.path or "", unattended=unattended
    )
    dest = Path(args.output) if args.output else policy_mod.runtime_cache_path(ctx.env)
    try:
        policy_mod.write_runtime_cache(dest, blob)
    except OSError as exc:
        out.error(f"cannot write {dest}: {exc}")
        return PROBLEM
    if args.json:
        out.json(blob)
        return OK
    out.say(f"wrote {dest}")
    out.say("  " + " ".join(f"rung{i}={ink.effect(e)}"
                            for i, e in enumerate(blob["table"]))
            + f"  {ink.dim('any path')}")
    for line in _rule_lines(blob, ink):
        out.say(line)
    if unattended:
        out.say(ink.dim("  unattended: nothing above can be ask, because there "
                        "is nobody to answer one"))
    if blob["path"]:
        out.say(ink.yellow(
            f"  --path {blob['path']} pins the table above to that one path, "
            "for every path. Path rules travel in the cache now; you almost "
            "certainly want `ap policy compile` with no --path."
        ))
    if blob["degraded"]:
        out.say(ink.red(f"  degraded: {blob['problem']}"))
    return OK


# -- policy explain ---------------------------------------------------------


def _considered(pol: Policy, rung: int, path: str) -> list[dict]:
    """Every layer, and why the ones that lost, lost. "nothing here matched" is
    the answer to most "why is my config being ignored" questions."""
    rows: list[dict] = []
    winner_taken = False
    for name in reversed(ALL_LAYERS):
        layer = pol.layer(name)
        if layer is None:
            rows.append({"layer": name, "rule": "-", "effect": "-",
                         "outcome": "no file"})
            continue
        rule = layer.rule_for(rung, path, floors=False)
        if rule is None:
            rows.append({"layer": name, "rule": "-", "effect": "-",
                         "outcome": "nothing for this rung"})
            continue
        outcome = "outranked" if winner_taken else "winner"
        winner_taken = True
        rows.append({"layer": name, "rule": rule.describe(),
                     "effect": rule.effects[rung], "outcome": outcome})
    for name in ALL_LAYERS:
        layer = pol.layer(name)
        if layer is None:
            continue
        rule = layer.rule_for(rung, path, floors=True)
        if rule is not None:
            rows.append({"layer": name, "rule": f"floor {rule.describe()}",
                         "effect": rule.effects[rung], "outcome": "floor"})
    return rows


def cmd_policy_explain(ctx: Context) -> int:
    args, out, ink = ctx.args, ctx.out, ctx.out.ink
    if args.rung not in RUNGS:
        out.error(f"rung {args.rung} does not exist; rungs are 0 through 4")
        return USAGE

    pol = ctx.policy()
    path = args.path
    res = pol.resolve(args.rung, path, unattended=ctx.unattended(args.unattended))
    rows = _considered(pol, args.rung, path)

    if args.json:
        out.json({**_resolution_json(res), "considered": rows,
                  "degraded": pol.degraded, "problems": list(pol.problems)})
        return OK

    out.say(f"{ink.bold(path)}  rung {args.rung}  ->  {ink.effect(res.effect)}")
    out.say()
    out.say(f"  {'winner':<11}{res.base:<9}{res.winning_layer} · "
            f"{res.winning_rule}  ({res.source})")
    if res.ceiling is None:
        out.say(f"  {'ceiling':<11}{'-':<9}the winning layer is not in observer mode")
    else:
        out.say(f"  {'ceiling':<11}{res.ceiling:<9}"
                f"{res.winning_layer} is in observer mode")
    tail = "  (floors beat ceilings)" if res.ceiling else ""
    out.say(f"  {'floor':<11}{res.floor:<9}{res.floor_layer or 'builtin'}{tail}")
    if res.unattended_promoted:
        out.say(f"  {'unattended':<11}{'deny':<9}"
                "ask has nobody to ask, so it becomes deny")
    out.say(f"  {'effect':<11}{ink.effect(res.effect)}")
    out.say()
    out.say("  " + res.reason())
    out.say()
    out.say(f"{ink.bold('considered')}  highest authority first")
    out.table(["layer", "rule", "effect", "outcome"],
              [[r["layer"], r["rule"], r["effect"], r["outcome"]] for r in rows])
    if pol.problems:
        out.say()
        out.say(ink.red("policy is degraded; run `ap policy check`"))
        for line in pol.problems:
            out.say(f"  {line}")
    return OK


# -- why --------------------------------------------------------------------


def _stamp(at_ms: int) -> str:
    if at_ms <= 0:
        return "--:--:--"
    return dt.datetime.fromtimestamp(at_ms / 1000.0).strftime("%H:%M:%S")


def cmd_why(ctx: Context) -> int:
    args, out, ink = ctx.args, ctx.out, ctx.out.ink
    path = journal_mod.journal_path(ctx.env)
    records = journal_mod.read_journal(path, limit=args.number, env=ctx.env)

    if args.json:
        out.json([r.as_dict() for r in records])
        return OK
    if not records:
        out.say(ink.dim(f"no decisions recorded yet ({path})"))
        return OK

    for record in records:
        out.say(f"{_stamp(record.at_ms)}  rung {record.rung}  "
                f"{ink.effect(record.effect)}  {record.path or '?'}")
        if record.holder or record.human:
            who = record.human or record.holder
            intent = f" — {record.intent}" if record.intent else ""
            out.say(f"    held by {who}{intent}")
        if record.reason:
            out.say(f"    {ink.dim(record.reason)}")
    return OK


# -- who --------------------------------------------------------------------


def cmd_who(ctx: Context) -> int:
    out, ink = ctx.out, ctx.out.ink
    path = ctx.snapshot_path()
    try:
        text = path.read_text(encoding="utf-8", errors="replace")
    except OSError:
        if ctx.args.json:
            out.json({"peers": [], "snapshot": str(path), "present": False})
            return OK
        out.say(ink.dim(f"no snapshot at {path} — presenced is not running"))
        return OK

    try:
        snap = json.loads(text)
    except ValueError:
        if ctx.args.json:
            out.json({"peers": [], "snapshot": str(path), "present": True,
                      "unreadable": True})
            return PROBLEM
        out.error(f"{path} is not readable JSON")
        return PROBLEM

    peers = [p for p in (snap.get("peers") or []) if isinstance(p, dict)] \
        if isinstance(snap, dict) else []
    degraded = bool(isinstance(snap, dict) and snap.get("policy_degraded"))
    problem = str(snap.get("policy_problem", "")) if isinstance(snap, dict) else ""

    if ctx.args.json:
        out.json({"peers": peers, "snapshot": str(path), "present": True,
                  "policy_degraded": degraded, "policy_problem": problem})
        return PROBLEM if degraded else OK

    if not peers:
        out.say(ink.dim("nobody else here"))
    else:
        out.table(["who", "verb", "where"],
                  [[str(p.get("human", "?")), str(p.get("verb", "?")),
                    str(p.get("path", ""))] for p in peers])
    if degraded:
        out.say()
        out.say(ink.red(f"policy degraded: {problem}"))
        return PROBLEM
    return OK


# -- principals -------------------------------------------------------------


def cmd_principals_list(ctx: Context) -> int:
    out, ink = ctx.out, ctx.out.ink
    path = ctx.roster_path()
    if path is None:
        out.error("not inside a git repo, so there is no roster to read")
        return PROBLEM
    roster = Roster.load(path)

    if ctx.args.json:
        out.json({
            "source": str(path),
            "present": roster.present,
            "default_tier": name_of(roster.default_tier),
            "problems": list(roster.problems),
            "principals": [
                {"id": p.id, "display": p.display,
                 "attended": name_of(p.attended),
                 "unattended": name_of(p.unattended)}
                for p in roster.principals()
            ],
        })
        return PROBLEM if roster.problems else OK

    people = roster.principals()
    if not people:
        out.say(ink.dim(
            f"no roster at {path} — everyone is {name_of(roster.default_tier)}"))
    else:
        out.say(f"{ink.bold('principals')}  {path}")
        out.table(["id", "display", "attended", "unattended"],
                  [[p.id, p.display, name_of(p.attended), name_of(p.unattended)]
                   for p in people])
        out.say()
        out.say(ink.dim(
            f"default tier {name_of(roster.default_tier)}. This is a seniority "
            "ordering among cooperating principals, not a security boundary."))
    for line in roster.problems:
        out.say(ink.red(f"  {line}"))
    return PROBLEM if roster.problems else OK


ROSTER_HEADER = (
    "# Who outranks whom. Committed and reviewed in a PR like any other code —\n"
    "# that review is the control point. The secret never lives here, only its\n"
    "# sha256, so a leaked roster leaks nothing.\n"
    "version = 1\n"
    'default_tier = "normal"\n'
)


def cmd_principals_add(ctx: Context) -> int:
    args, out, ink = ctx.args, ctx.out, ctx.out.ink
    path = ctx.roster_path()
    if path is None:
        out.error("not inside a git repo, so there is nowhere to write a roster")
        return PROBLEM
    try:
        attended = parse_priority(args.attended)
        unattended = parse_priority(args.unattended or args.attended)
    except ValueError as exc:
        out.error(str(exc))
        return USAGE
    if attended > unattended:
        out.error(f"attended {name_of(attended)} is above unattended "
                  f"{name_of(unattended)}; the band runs the other way")
        return USAGE

    if any(p.id == args.id for p in Roster.load(path).principals()):
        out.error(f"{args.id!r} is already in {path}; edit it by hand")
        return PROBLEM

    token = mint_token()
    block = (
        "\n[[principal]]\n"
        f"id           = {json.dumps(args.id)}\n"
        f"display      = {json.dumps(args.display or args.id)}\n"
        f"attended     = {json.dumps(name_of(attended))}\n"
        f"unattended   = {json.dumps(name_of(unattended))}\n"
        f"token_sha256 = {json.dumps(hash_token(token))}\n"
    )
    try:
        if not path.exists():
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text(ROSTER_HEADER, encoding="utf-8")
        with open(path, "a", encoding="utf-8") as f:
            f.write(block)
    except OSError as exc:
        out.error(f"cannot write {path}: {exc}")
        return PROBLEM

    out.say(f"added {args.id} to {path}")
    out.say()
    out.say(f"  token  {ink.bold(token)}")
    out.say(ink.dim(
        "  Printed once. Put it in ~/.config/agent-presence/token (chmod 600),\n"
        "  or $AGENT_PRESENCE_TOKEN, on the machine that runs as this\n"
        "  principal. Whoever can read that file is this principal."))
    return OK


# -- token ------------------------------------------------------------------


def cmd_token_mint(ctx: Context) -> int:
    ctx.out.say(mint_token())
    return OK


def cmd_token_hash(ctx: Context) -> int:
    raw = ctx.args.token
    if raw is None:
        raw = sys.stdin.read()
    raw = raw.strip()
    if not raw:
        ctx.out.error("no token given, and stdin was empty")
        return USAGE
    ctx.out.say(hash_token(raw))
    return OK


# -- doctor -----------------------------------------------------------------


@dataclass(frozen=True)
class Check:
    name: str
    state: str  # ok | warn | fail
    detail: str


def _socket_check(name: str, path: Path) -> Check:
    if not path.exists():
        return Check(name, "fail", f"{path} is not there — presenced is not running")
    probe = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    probe.settimeout(0.5)
    try:
        probe.connect(str(path))
    except OSError as exc:
        return Check(name, "fail", f"{path} will not accept a connection: {exc}")
    finally:
        probe.close()
    return Check(name, "ok", str(path))


def _cache_check(ctx: Context, pol: Policy) -> Check:
    """Is the cache the daemon reads the one `ap policy compile` would write?

    That is a bigger question than "do the files match", and it has to be:
    `compile` takes a supervision bit and a path as well as the files, both of
    them change the table it writes, and neither was in the digest. So a cache
    compiled `--unattended`, holding `deny` at rung 3, matched a config saying
    `ask` and this check said `ok` — the daemon on a table nothing on disk
    describes, and the command whose whole job is to notice reporting green.
    """
    path = policy_mod.runtime_cache_path(ctx.env)
    unattended = ctx.unattended()
    try:
        blob = json.loads(path.read_text(encoding="utf-8"))
    except OSError:
        return Check("runtime cache", "fail",
                     f"{path} is missing — the daemon is running on the builtin "
                     "table. Run `ap policy compile`.")
    except ValueError:
        return Check("runtime cache", "fail",
                     f"{path} is not readable JSON. Run `ap policy compile`.")
    if not isinstance(blob, dict):
        return Check("runtime cache", "fail", f"{path} is not a policy blob")

    want = policy_mod.compile_runtime(pol, unattended=unattended)
    table = " ".join(str(e) for e in blob.get("table", []))

    if blob.get("policy_digest") != pol.digest:
        return Check("runtime cache", "fail",
                     f"{path} does not match the files on disk — the daemon is "
                     "one edit behind. Run `ap policy compile`.")
    if bool(blob.get("unattended")) != unattended:
        was = "an unattended" if blob.get("unattended") else "an attended"
        now = "unattended" if unattended else "attended"
        return Check("runtime cache", "fail",
                     f"{path} was compiled for {was} run and this one is "
                     f"{now}, so the daemon is on [{table}]. "
                     "Run `ap policy compile`.")
    if str(blob.get("path", "")):
        return Check("runtime cache", "fail",
                     f"{path} was compiled with --path {blob['path']}, so it "
                     f"serves that one path's table [{table}] for every path. "
                     "Run `ap policy compile` with no --path.")
    if blob.get("digest") != want["digest"]:
        return Check("runtime cache", "fail",
                     f"{path} was compiled from different inputs than the ones "
                     "here. Run `ap policy compile`.")
    for key in ("table", "floor", "rules", "floors"):
        if blob.get(key) != want[key]:
            return Check("runtime cache", "fail",
                         f"{path} carries the right digest and a different "
                         f"{key} — it has been edited by hand. "
                         "Run `ap policy compile`.")

    rules = sum(1 for entry in want["rules"] + want["floors"] if entry["match"])
    extra = f", {rules} path rule(s)" if rules else ""
    return Check("runtime cache", "ok", f"{path}  [{table}]{extra}")


def _principal_check(ctx: Context, roster: Roster) -> Check:
    """Whether this machine actually presents the principal it thinks it does.

    `ap principals add` prints a token once and tells you where to put it. Every
    way of getting that wrong — a typo in the name, a token pasted with a stray
    character, the file never written — fails open at the relay: the connection
    joins and gets the default tier. Which is the right behaviour and a terrible
    symptom, because it looks exactly like working right up until the contest
    you should have won.
    """
    principal = ctx.env.get(principals_mod.PRINCIPAL_ENV, "").strip()
    unattended = ctx.unattended()
    if not principal:
        return Check("principal", "ok",
                     f"nothing configured (${principals_mod.PRINCIPAL_ENV}); "
                     "this machine joins as normal")

    token = principals_mod.read_token(ctx.env)
    entry = next((p for p in roster.principals() if p.id == principal), None)
    if entry is None:
        where = roster.source if roster.present else "no roster"
        return Check("principal", "fail",
                     f"{principal!r} is not in the roster ({where}); the relay "
                     f"will grant {name_of(roster.default_tier)}")

    tier = name_of(entry.unattended if unattended else entry.attended)
    supervision = "unattended" if unattended else "attended"

    if not token:
        return Check("principal", "warn",
                     f"{principal} is configured but there is no token "
                     f"({principals_mod.token_path(ctx.env)}); the relay will "
                     f"grant {name_of(roster.default_tier)}, not {tier}")

    if hash_token(token) != entry.token_sha256:
        return Check("principal", "fail",
                     f"the token for {principal} does not match the roster; "
                     f"the relay will grant {name_of(roster.default_tier)}. "
                     "Re-mint with `ap principals add`, or fix the file")

    detail = f"{principal} -> {tier} ({supervision})"

    # Only when the secret is on disk. An env var has its own exposure and the
    # mode of a file nobody read is not news about it.
    if not ctx.env.get(principals_mod.TOKEN_ENV, "").strip():
        path = principals_mod.token_path(ctx.env)
        try:
            mode = path.stat().st_mode & 0o777
        except OSError:
            mode = None
        if mode is not None and mode & 0o077:
            return Check("principal", "warn",
                         f"{detail}, but {path} is {mode:04o} — anyone who can "
                         "read it is this principal. chmod 600")

    return Check("principal", "ok", detail)


def cmd_doctor(ctx: Context) -> int:
    out, ink = ctx.out, ctx.out.ink
    pol = ctx.policy()
    checks: list[Check] = []

    if ctx.repo_root is None:
        checks.append(Check("repo", "warn",
                            "not inside a git repo; no repo layer, no roster"))
    else:
        checks.append(Check("repo", "ok", str(ctx.repo_root)))

    sock = ctx.sock_path()
    checks.append(_socket_check("event socket", sock))
    checks.append(_socket_check("decision socket", Path(str(sock) + ".decide")))

    snap = ctx.snapshot_path()
    if snap.exists():
        checks.append(Check("snapshot", "ok", str(snap)))
    else:
        checks.append(Check("snapshot", "warn",
                            f"{snap} is not there; the statusline stays blank"))

    for name, layer, file in _layers_view(ctx, pol):
        findings, extra = _lint_layer(ctx, name, layer, file)
        errors = [f for f in findings if f.severity == "error"]
        if errors or extra:
            first = errors[0].render(str(file)) if errors else extra[0]
            checks.append(Check(f"policy:{name}", "fail", first))
        elif any(f.severity == "warning" for f in findings):
            first = next(f for f in findings if f.severity == "warning")
            checks.append(Check(f"policy:{name}", "warn", first.render(str(file))))
        else:
            checks.append(Check(f"policy:{name}", "ok",
                                _source_of(name, layer, file)))

    checks.append(_cache_check(ctx, ctx.client_policy()))

    roster_path = ctx.roster_path()
    roster = Roster.inert()
    if roster_path is None:
        checks.append(Check("roster", "ok", "no repo, so everyone is normal"))
    else:
        roster = Roster.load(roster_path)
        if roster.problems:
            checks.append(Check("roster", "fail", roster.problems[0]))
        elif not roster.present:
            checks.append(Check("roster", "ok",
                                f"{roster_path} (absent, everyone is normal)"))
        else:
            checks.append(Check("roster", "ok",
                                f"{roster_path}, "
                                f"{len(roster.principals())} principal(s)"))

    checks.append(_principal_check(ctx, roster))

    jpath = journal_mod.journal_path(ctx.env)
    if jpath.exists():
        count = len(journal_mod.read_journal(jpath, limit=0, env=ctx.env))
        checks.append(Check("journal", "ok", f"{jpath} ({count} decisions)"))
    else:
        checks.append(Check("journal", "warn", f"{jpath} is not there yet"))

    failed = [c for c in checks if c.state == "fail"]

    if ctx.args.json:
        out.json({"ok": not failed,
                  "checks": [{"name": c.name, "state": c.state,
                              "detail": c.detail} for c in checks]})
        return PROBLEM if failed else OK

    marks = {"ok": ink.green("ok  "), "warn": ink.yellow("warn"),
             "fail": ink.red("FAIL")}
    width = max(len(c.name) for c in checks)
    for c in checks:
        out.say(f"{marks[c.state]}  {c.name.ljust(width)}  {c.detail}")
    out.say()
    if failed:
        out.say(ink.red(
            f"{len(failed)} check(s) failed. None of this blocks an agent — the "
            "builtin table stays in force and nothing falls below the builtin "
            "floor — but you are not getting the policy you configured."))
        return PROBLEM
    out.say(ink.green("everything checks out"))
    return OK


# -- parser -----------------------------------------------------------------


def _help_for(parser: argparse.ArgumentParser) -> Callable[[Context], int]:
    def run(ctx: Context) -> int:
        parser.print_help(ctx.out.stdout)
        return USAGE
    return run


def _add_json(parser: argparse.ArgumentParser) -> None:
    parser.add_argument("--json", action="store_true",
                        help="machine-readable output, never coloured")


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="ap",
        description=(
            "agent-presence from the terminal. The policy file is the state and "
            "these are the verbs. Saved is applied; nothing needs restarting."
        ),
        epilog=(
            "the two you will actually use:\n"
            "  ap policy show --effective   what is in force, and where each "
            "line came from\n"
            "  ap why                       why the last thing that stopped "
            "you, stopped you\n"
        ),
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    parser.add_argument("--color", choices=("auto", "always", "never"),
                        default="auto",
                        help="colour output (default: auto, on when stdout is a tty)")
    parser.add_argument("-C", "--directory", default=None, metavar="DIR",
                        help="run as if started in DIR")
    parser.add_argument("-v", "--verbose", action="store_true",
                        help="show the library's own log lines on stderr")
    parser.set_defaults(run=_help_for(parser))
    groups = parser.add_subparsers(metavar="COMMAND")

    policy = groups.add_parser(
        "policy", help="inspect and edit the policy",
        description="The policy file is the state. These verbs read and write it.")
    policy.set_defaults(run=_help_for(policy))
    psub = policy.add_subparsers(metavar="SUBCOMMAND")

    show = psub.add_parser(
        "show", help="print the policy, per layer or as it resolves",
        description="With no flags: every layer and its rules, as written. With "
                    "--effective: what those layers actually resolve to, and "
                    "which one each value came from.")
    show.add_argument("--effective", action="store_true",
                      help="the resolved five-rung table and the source of each value")
    show.add_argument("--layer", choices=ALL_LAYERS, help="only this layer")
    show.add_argument("--path", default="", metavar="PATH",
                      help="resolve for this path; path rules only apply to a path")
    show.add_argument("--unattended", action="store_true",
                      help="resolve as an unsupervised run, where ask becomes deny")
    _add_json(show)
    show.set_defaults(run=cmd_policy_show)

    path_cmd = psub.add_parser(
        "path", help="print the file behind a layer",
        description="$EDITOR $(ap policy path) is the intended edit flow.")
    path_cmd.add_argument("--layer", choices=EDITABLE_LAYERS, default="user")
    path_cmd.set_defaults(run=cmd_policy_path)

    set_cmd = psub.add_parser(
        "set", help="set one value, e.g. rung3=ask",
        description="Writes the file in place. Comments and key order survive.")
    set_cmd.add_argument("assignment", metavar="KEY=VALUE",
                         help="rung0..rung4 = silent|notify|context|ask|deny, "
                              "or mode = normal|observer")
    set_cmd.add_argument("--layer", choices=EDITABLE_LAYERS, default="user")
    set_cmd.add_argument("--path", default=None, metavar="GLOB",
                         help="apply only to paths matching GLOB")
    set_cmd.add_argument("--floor", action="store_true",
                         help="write a floor, which nothing quieter undercuts "
                              "(org and repo layers only)")
    set_cmd.set_defaults(run=cmd_policy_set)

    unset = psub.add_parser("unset", help="remove one value",
                            description="The inverse of set, byte for byte.")
    unset.add_argument("key", metavar="RUNG", help="rung0 through rung4")
    unset.add_argument("--layer", choices=EDITABLE_LAYERS, default="user")
    unset.add_argument("--path", default=None, metavar="GLOB")
    unset.add_argument("--floor", action="store_true")
    unset.set_defaults(run=cmd_policy_unset)

    check = psub.add_parser(
        "check", help="parse every layer and report problems by line",
        description="Exit 1 if anything is degraded. Every problem names the "
                    "file and the line it is on.")
    check.add_argument("--layer", choices=ALL_LAYERS)
    _add_json(check)
    check.set_defaults(run=cmd_policy_check)

    compile_cmd = psub.add_parser(
        "compile", help="write the runtime cache the daemon reads",
        description="Resolves the client-side layers into one line of JSON, "
                    "path rules and all. The daemon stats it on a tick it "
                    "already runs and never parses TOML.")
    compile_cmd.add_argument("-o", "--output", default=None, metavar="PATH")
    compile_cmd.add_argument("--path", default="", metavar="PATH",
                             help="pin the blanket table to this one path. "
                                  "Rarely what you want: path rules travel in "
                                  "the cache on their own now")
    compile_cmd.add_argument("--unattended", action="store_true",
                             help="compile for a run with nobody to ask, where "
                                  "ask becomes deny. On anyway when "
                                  "$AGENT_PRESENCE_UNATTENDED is set")
    _add_json(compile_cmd)
    compile_cmd.set_defaults(run=cmd_policy_compile)

    explain = psub.add_parser(
        "explain", help="trace one decision end to end",
        description="Which rule won, which lost, what capped it, what raised it.")
    explain.add_argument("path", metavar="PATH")
    explain.add_argument("--rung", type=int, required=True, metavar="N",
                         help="0 through 4")
    explain.add_argument("--unattended", action="store_true")
    _add_json(explain)
    explain.set_defaults(run=cmd_policy_explain)

    why = groups.add_parser(
        "why", help="the last real decisions, and their reasons",
        description="Read from the daemon's journal. A block you cannot get a "
                    "reason for is a block you stop trusting.")
    why.add_argument("-n", "--number", type=int, default=10, metavar="N")
    _add_json(why)
    why.set_defaults(run=cmd_why)

    who = groups.add_parser("who", help="who else is in this repo right now",
                            description="The snapshot, as the statusline sees it.")
    _add_json(who)
    who.set_defaults(run=cmd_who)

    principals = groups.add_parser(
        "principals", help="the priority roster",
        description="Priority lives here and not in policy.toml, because a tier "
                    "the client can set is decoration.")
    principals.set_defaults(run=_help_for(principals))
    prsub = principals.add_subparsers(metavar="SUBCOMMAND")
    plist = prsub.add_parser("list", help="print the roster")
    _add_json(plist)
    plist.set_defaults(run=cmd_principals_list)
    padd = prsub.add_parser("add", help="add a principal, printing its token once")
    padd.add_argument("id")
    padd.add_argument("--attended", default="normal", choices=tuple(PRIORITY_NAMES))
    padd.add_argument("--unattended", default=None, choices=tuple(PRIORITY_NAMES))
    padd.add_argument("--display", default=None)
    padd.set_defaults(run=cmd_principals_add)

    token = groups.add_parser("token", help="mint and hash bearer tokens")
    token.set_defaults(run=_help_for(token))
    tsub = token.add_subparsers(metavar="SUBCOMMAND")
    tsub.add_parser("mint", help="print a new token").set_defaults(
        run=cmd_token_mint)
    thash = tsub.add_parser("hash", help="print the sha256 the roster stores")
    thash.add_argument("token", nargs="?", default=None,
                       help="the token, or leave it off to read stdin")
    thash.set_defaults(run=cmd_token_hash)

    doctor = groups.add_parser(
        "doctor", help="check the whole install; exit 1 if anything is degraded",
        description="Sockets, snapshot, every policy layer, the runtime cache, "
                    "the roster and the journal.")
    _add_json(doctor)
    doctor.set_defaults(run=cmd_doctor)

    return parser


def main(argv: Sequence[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(list(argv) if argv is not None else None)

    # The loaders log every problem they find, and this tool's whole job is to
    # print those problems properly. Two copies of the same line, one of them
    # unformatted on stderr, is worse than one. -v puts them back.
    lib = logging.getLogger("agent_presence")
    if args.verbose:
        logging.basicConfig(level=logging.INFO, stream=sys.stderr,
                            format="ap: %(name)s: %(message)s")
    else:
        lib.addHandler(logging.NullHandler())
        lib.propagate = False

    env = os.environ
    colour = "never" if getattr(args, "json", False) else args.color
    out = Out(sys.stdout, sys.stderr, Ink.decide(colour, sys.stdout, env))

    cwd = Path(args.directory) if args.directory else Path.cwd()
    if not cwd.is_dir():
        out.error(f"{cwd} is not a directory")
        return USAGE

    ctx = Context(args, out, env, cwd)
    try:
        return int(args.run(ctx))
    except BrokenPipeError:  # pragma: no cover - `ap policy show | head`
        return OK
    except KeyboardInterrupt:  # pragma: no cover
        return 130


if __name__ == "__main__":  # pragma: no cover
    raise SystemExit(main())
