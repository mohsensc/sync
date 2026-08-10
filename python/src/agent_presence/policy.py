"""Policy: how loudly a rung is told, and nothing else.

The line that makes everything here safe:

    Policy governs presentation and blocking. It never governs lease grants.

``LeaseRegistry.acquire``, ``wait_die.resolve`` and ``same_region`` run exactly
as they did before, for every rung, under every policy. A room configured to
``rung3 = "notify"`` still refuses the second claim, still returns
``decision: wait|abort``, still publishes the lease — it just doesn't stop the
edit. The lease table stays a truthful record of who holds what; the effect
decides how loudly that truth gets told. So no policy value can corrupt
arbitration, and the deadlock argument in ``wait_die`` survives the whole
effect lattice untouched.

Two axes, kept apart on purpose:

- **Authority** is the layer: builtin < org < repo < user < session.
- **Specificity** is the path glob, which is a selector *inside* a layer.

Making globs a sixth layer would produce a lattice, and then somebody has to
rule on whether a repo-level glob beats a user-level blanket. That question has
no good answer, so it is not asked.

Nothing in here raises. Every bad field falls back to its documented default and
appends exactly one line to ``problems``, which is the same discipline
``redact.py`` and ``serve.py`` already use. Falling back is always to the
builtin table, never to "off": there is no code path from a parse error to a
quieter product.
"""

from __future__ import annotations

import hashlib
import json
import logging
import os
import re
import tempfile
import tomllib
from collections.abc import Collection, Mapping, Sequence
from dataclasses import dataclass, replace
from pathlib import Path
from typing import Literal

from .clock import Clock

log = logging.getLogger("agent_presence.policy")

SCHEMA_VERSION = 1
# How often a PolicyFile is allowed to stat its inputs. Live reload is worth a
# stat per second and is not worth one per decision.
RECHECK_S = 1.0
RUNGS = range(5)

# -- effects -----------------------------------------------------------------
#
# Five, totally ordered by attention spent. The ordering is what floors and
# ceilings clamp on: `stricter` is "louder", `quieter` is "less".

Effect = Literal["silent", "notify", "context", "ask", "deny"]
EFFECTS: tuple[Effect, ...] = ("silent", "notify", "context", "ask", "deny")
RANK: Mapping[str, int] = {e: i for i, e in enumerate(EFFECTS)}

LayerName = Literal["builtin", "org", "repo", "user", "session"]
# Least authority first. `resolve` walks this backwards looking for an effect
# and forwards accumulating floors.
LAYER_ORDER: tuple[LayerName, ...] = ("builtin", "org", "repo", "user", "session")
# Floors are a statement by the people responsible for the code, so they are
# declarable only where those people are. A [floor] block anywhere else parses,
# warns and is ignored — dropping it silently would let someone believe they had
# hardened their own setup.
FLOOR_LAYERS: frozenset[str] = frozenset({"org", "repo"})

Mode = Literal["normal", "observer"]
MODES: tuple[Mode, ...] = ("normal", "observer")
# The only ceiling mechanism there is. Anyone must always be able to make their
# own agent stricter, so there is no way to cap anybody else.
OBSERVER_CEILING: Effect = "notify"

ORG_POLICY_ENV = "AGENT_PRESENCE_ORG_POLICY"
ORG_POLICY_DEFAULT = "/etc/agent-presence/policy.toml"
SESSION_POLICY_ENV = "AGENT_PRESENCE_POLICY"
SESSION_RUNG_ENV = "AGENT_PRESENCE_POLICY_RUNG"
REPO_ROOT_ENV = "AGENT_PRESENCE_REPO_ROOT"
REPO_POLICY_RELPATH = ".agent-presence/policy.toml"
USER_POLICY_RELPATH = "agent-presence/policy.toml"
RUNTIME_CACHE_NAME = "agent-presence.policy.json"


def stricter(a: Effect, b: Effect) -> Effect:
    return a if RANK[a] >= RANK[b] else b


def quieter(a: Effect, b: Effect) -> Effect:
    return a if RANK[a] <= RANK[b] else b


def opens_negotiation(effect: Effect) -> bool:
    """True for the two effects that spend somebody's attention.

    ``silent``, ``notify`` and ``context`` all leave ``permissionDecision``
    unset on the hook and leave the relay answering ``ack``. Only ``ask`` and
    ``deny`` interrupt, and neither is a shipped default below rung 3.
    """
    return RANK[effect] >= RANK["ask"]


@dataclass(frozen=True)
class EffectTable:
    """Five effects, one per rung. The whole decision-relevant slice of a
    policy, and the only part the daemon ever sees."""

    rungs: tuple[Effect, Effect, Effect, Effect, Effect]

    def __getitem__(self, rung: int) -> Effect:
        return self.rungs[_rung_index(rung)]

    def raised_to(self, floor: "EffectTable") -> "EffectTable":
        return EffectTable(
            tuple(stricter(a, b) for a, b in zip(self.rungs, floor.rungs))
        )

    def capped_at(self, ceiling: Effect) -> "EffectTable":
        return EffectTable(tuple(quieter(e, ceiling) for e in self.rungs))

    def names(self) -> list[str]:
        return list(self.rungs)


# Installing this and configuring nothing is a no-op, and there is a golden test
# for exactly that.
#
# Rung 3 defaults to `deny`, not `ask`: rung 3 is a fact (a relay-granted lease
# on a contending region), `ask` spends a human's attention while `deny` spends
# the model's and hands it four moves plus a PROCEED escape hatch, and for the
# unattended agents this feature exists to serve there is nobody to ask.
BUILTIN = EffectTable(("silent", "notify", "context", "deny", "silent"))

# The floor at rung 3 is `notify`, not `silent`. A silent rung 3 is the product
# lying: two agents editing one symbol with nothing said anywhere is the
# pre-install world. If that is what you want, uninstall — or say
# `mode = "observer"`, which says it honestly and keeps the statusline truthful.
BUILTIN_FLOOR = EffectTable(("silent", "silent", "silent", "notify", "silent"))


def _rung_index(rung: int) -> int:
    """Fold a rung into 0..4 rather than raising.

    Nothing in the shipped code can produce a rung outside the range —
    ``ladder.classify`` returns 0..3 — but this is called from the decision
    path, and the decision path does not get to throw.
    """
    try:
        value = int(rung)
    except (TypeError, ValueError):
        return 0
    return max(0, min(4, value))


# -- rules and layers --------------------------------------------------------

_GLOB_CACHE: dict[str, re.Pattern[str] | None] = {}


def _compile_glob(pattern: str) -> re.Pattern[str] | None:
    """Translate a path glob to a regex. None when the glob is malformed.

    ``**`` crosses directory separators, ``*`` and ``?`` do not. fnmatch would
    do neither — it maps ``*`` to ``.*`` — so ``src/*.py`` there would match
    ``src/a/b.py``, which is not what anyone writing that line means.
    """
    if pattern in _GLOB_CACHE:
        return _GLOB_CACHE[pattern]

    out: list[str] = []
    i, n = 0, len(pattern)
    while i < n:
        ch = pattern[i]
        if ch == "*":
            if pattern.startswith("**/", i):
                # A leading `**/` has to be able to match nothing at all, so
                # `**/x.py` catches a bare `x.py` as well as `a/b/x.py`.
                out.append("(?:.*/)?")
                i += 3
                continue
            if pattern.startswith("**", i):
                out.append(".*")
                i += 2
                continue
            out.append("[^/]*")
            i += 1
            continue
        if ch == "?":
            out.append("[^/]")
            i += 1
            continue
        if ch == "[":
            close = pattern.find("]", i + 1)
            if close == -1:
                _GLOB_CACHE[pattern] = None
                return None
            body = pattern[i + 1:close]
            if body.startswith("!"):
                body = "^" + body[1:]
            out.append("[" + body + "]")
            i = close + 1
            continue
        out.append(re.escape(ch))
        i += 1

    try:
        compiled = re.compile("".join(out) + r"\Z")
    except re.error:
        compiled = None
    _GLOB_CACHE[pattern] = compiled
    return compiled


def valid_glob(pattern: str) -> bool:
    return bool(pattern) and _compile_glob(pattern) is not None


_WILDCARD = re.compile(r"[*?\[]")

# What `specificity` returns. Compared componentwise, bigger is narrower.
Specificity = tuple[int, int, int, int]


def _literal_chars(pattern: str) -> int:
    """How many characters of the glob only ever match themselves.

    Wildcard tokens contribute nothing: ``**``, ``*``, ``?`` and a whole
    ``[...]`` class are each skipped, so ``src/*.py`` counts 7 and ``src/**``
    counts 4.

    ``**/`` is one token, separator included, because that is what it means and
    what ``_compile_glob`` compiles it to — it has to be able to match nothing
    at all, so ``**/pay.py`` matches ``pay.py``. Counting the slash would make
    ``**/pay.py`` narrower than ``pay.py``, which is backwards: it is the same
    pattern with a wider reach.
    """
    count = 0
    i, n = 0, len(pattern)
    while i < n:
        ch = pattern[i]
        if ch == "*":
            if pattern.startswith("**/", i):
                i += 3
                continue
            i += 2 if pattern.startswith("**", i) else 1
            continue
        if ch == "?":
            i += 1
            continue
        if ch == "[":
            close = pattern.find("]", i + 1)
            i = i + 1 if close == -1 else close + 1
            continue
        count += 1
        i += 1
    return count


def _literal_prefix(pattern: str) -> int:
    found = _WILDCARD.search(pattern)
    return len(pattern) if found is None else found.start()


@dataclass(frozen=True)
class Rule:
    """One line of policy: which paths, which rungs, which effects."""

    # None is the blanket rule for the layer.
    match: str | None
    effects: Mapping[int, Effect]
    is_floor: bool
    # Position in the file, so an exact-specificity tie has a defined winner and
    # something to warn about.
    order: int

    def matches(self, path: str) -> bool:
        if self.match is None:
            return True
        compiled = _compile_glob(self.match)
        return compiled is not None and compiled.match(path) is not None

    def specificity(self) -> Specificity:
        """How narrow this glob is. Bigger wins. ``(-1,)*4`` for the blanket
        rule, so any path rule beats it without a special case.

        Filename first, then directory. This used to be the length of the
        literal prefix and that read the file backwards: ``**/pay.py`` has a
        wildcard at index 0, so it scored 0 and lost to *every* directory glob.
        Someone writing

            [[floor.path]]
            match = "**/pay.py"
            rung3 = "deny"

            [[floor.path]]
            match  = "vendor/**"
            rung3  = "silent"

        got a silent rung 3 on ``vendor/pay.py``, with no tie warning, because
        ties only fire on *equal* scores and 0 != 7. A narrow-looking line
        turned off a broad-looking hard floor and nothing said so.

        The four components, in order:

        1. whether the last segment is pinned exactly — ``**/pay.py`` names one
           filename, ``vendor/**`` names none;
        2. how much of that last segment is literal, so ``*.py`` beats ``*``;
        3. the literal prefix of the directory part, so ``src/payments/**``
           beats ``src/**``;
        4. literal characters overall, as the final tiebreak.

        Pinning a filename beats pinning a directory because that is how people
        read these files: "payments always blocks" is a statement about the
        file, and the directory line is the background it is written against.

        ``**/pay.py`` and ``pay.py`` score the same and that is deliberate: they
        are equally specific about the only thing that decides a match here, so
        it goes to the file-order tiebreak *and warns*, which is the outcome the
        old code should have produced for the case above.
        """
        if self.match is None:
            return (-1, -1, -1, -1)
        head, _, base = self.match.rpartition("/")
        pinned = 0 if _WILDCARD.search(base) else 1
        return (
            pinned,
            _literal_chars(base),
            _literal_prefix(head),
            _literal_chars(self.match),
        )

    def describe(self) -> str:
        return "blanket" if self.match is None else self.match


@dataclass(frozen=True)
class Layer:
    """One policy file, parsed. Or the compiled-in defaults."""

    name: LayerName
    source: str
    mode: Mode
    rules: tuple[Rule, ...]
    problems: tuple[str, ...]
    # False when the text could not be read as TOML at all. A layer that lost
    # one key is degraded; a layer that lost everything is what makes
    # PolicyFile hold on to the last good table instead.
    parsed: bool = True

    def _candidates(self, rung: int, path: str, *, floors: bool) -> list[Rule]:
        rung = _rung_index(rung)
        return [
            r for r in self.rules
            if r.is_floor is floors and rung in r.effects and r.matches(path)
        ]

    def rule_for(self, rung: int, path: str, *, floors: bool) -> Rule | None:
        """The winning rule in this layer: path beats blanket, longest literal
        prefix beats shorter, exact tie goes to the later line."""
        best: Rule | None = None
        for rule in self._candidates(rung, path, floors=floors):
            if best is None or (rule.specificity(), rule.order) > (
                best.specificity(), best.order
            ):
                best = rule
        return best

    def floor_for(self, rung: int, path: str) -> tuple[Effect, Rule] | None:
        """The strictest floor this layer sets for the path, and which line set
        it. None when the layer floors this rung nowhere.

        Strictest, not most specific, and that is the whole difference between a
        floor and an effect. An effect is "what happens here", so a narrower line
        replaces a broader one. A floor is "this never goes below", so a second
        line can only ever raise it — the same rule floors already follow across
        layers (``_floor_for``), applied inside one layer too.

        Without this, one quiet line could switch off a hard floor written three
        lines above it, and nothing in the file looked like it did that. Now
        lowering a floor for a subtree is not expressible, which is correct: a
        floor you can carve holes in is a default with extra steps.
        """
        best: tuple[Effect, Rule] | None = None
        for rule in self._candidates(rung, path, floors=True):
            candidate = rule.effects[_rung_index(rung)]
            if best is None or RANK[candidate] > RANK[best[0]]:
                best = (candidate, rule)
        return best

    def tie_for(self, rung: int, path: str, *, floors: bool) -> Rule | None:
        """The rule that lost an exact-specificity tie, if one did.

        Worth reporting rather than resolving quietly: two lines with the same
        literal prefix both claiming a rung is somebody's mistake, and which one
        wins is a detail of file order they probably did not intend to rely on.
        """
        winner = self.rule_for(rung, path, floors=floors)
        if winner is None:
            return None
        for rule in self._candidates(rung, path, floors=floors):
            if rule is not winner and rule.specificity() == winner.specificity():
                return rule
        return None


def builtin_layer() -> Layer:
    return Layer(
        name="builtin",
        source="<builtin>",
        mode="normal",
        rules=(
            Rule(
                match=None,
                effects={r: BUILTIN[r] for r in RUNGS},
                is_floor=False,
                order=0,
            ),
        ),
        problems=(),
    )


# -- resolution --------------------------------------------------------------


@dataclass(frozen=True)
class Resolution:
    """Every input to one decision, not just the answer.

    ``ap policy explain`` and ``why_was_i_blocked`` print this, which is the
    whole of requirement 4's "reason": a blocked agent is exactly who needs to
    know why, and "the policy said so" is not an answer anybody can act on.
    """

    rung: int
    path: str
    effect: Effect
    # Before the ceiling and the floor were applied.
    base: Effect
    winning_layer: LayerName
    winning_rule: str
    ceiling: Effect | None
    floor: Effect
    floor_layer: LayerName | None
    unattended_promoted: bool
    problems: tuple[str, ...]
    source: str = "<builtin>"

    def reason(self) -> str:
        parts = [
            f"rung {self.rung} on {self.path or '<any path>'} resolves to "
            f"{self.effect}: {self.winning_layer} layer ({self.source}) "
            f"{self.winning_rule} rule says {self.base}"
        ]
        if self.ceiling is not None and RANK[self.ceiling] < RANK[self.base]:
            parts.append(f"capped at {self.ceiling} by mode = observer")
        if RANK[self.floor] > RANK[quieter(self.base, self.ceiling or self.base)]:
            where = self.floor_layer or "builtin"
            parts.append(f"raised to {self.floor} by the {where} floor")
        if self.unattended_promoted:
            parts.append("promoted ask -> deny because nobody is watching")
        return "; ".join(parts)


@dataclass(frozen=True)
class Policy:
    """A stack of layers and the answers you can get out of it."""

    layers: tuple[Layer, ...]
    digest: str
    loaded_at: float
    degraded: bool
    problems: tuple[str, ...]

    def layer(self, name: str) -> Layer | None:
        for candidate in self.layers:
            if candidate.name == name:
                return candidate
        return None

    def _floor_for(self, rung: int, path: str) -> tuple[Effect, LayerName | None]:
        floor: Effect = BUILTIN_FLOOR[rung]
        source: LayerName | None = None
        # Least authority first, so a repo floor can only ever raise an org one.
        # Floors compose upward and never downward: the strictest wins.
        for layer in self._ordered():
            if layer.name not in FLOOR_LAYERS:
                continue
            found = layer.floor_for(rung, path)
            if found is None:
                continue
            candidate, _rule = found
            if RANK[candidate] > RANK[floor]:
                floor, source = candidate, layer.name
        return floor, source

    def _ordered(self) -> list[Layer]:
        return sorted(
            self.layers,
            key=lambda layer: LAYER_ORDER.index(layer.name)
            if layer.name in LAYER_ORDER else 0,
        )

    def resolve(self, rung: int, path: str, *, unattended: bool = False) -> Resolution:
        rung = _rung_index(rung)
        path = path or ""

        base: Effect = BUILTIN[rung]
        winning_layer: LayerName = "builtin"
        winning_rule = "blanket"
        source = "<builtin>"
        mode: Mode = "normal"
        problems: list[str] = list(self.problems)

        # Highest authority with anything to say about this rung wins outright.
        for layer in reversed(self._ordered()):
            rule = layer.rule_for(rung, path, floors=False)
            if rule is None:
                continue
            base = rule.effects[rung]
            winning_layer = layer.name
            winning_rule = rule.describe()
            source = layer.source
            mode = layer.mode
            loser = layer.tie_for(rung, path, floors=False)
            if loser is not None:
                problems.append(
                    f"{layer.source}: rung{rung} rules {loser.describe()!r} and "
                    f"{rule.describe()!r} are equally specific for {path!r}; "
                    f"the later one wins"
                )
            break

        # Step 2: the only ceiling there is, and it applies to the layer that
        # won — `mode` is a statement about how that layer wants to be read.
        ceiling: Effect | None = OBSERVER_CEILING if mode == "observer" else None
        effect = base if ceiling is None else quieter(base, ceiling)

        # Step 3, and it has to be this way round. `mode = "observer"` is a
        # personal preference; a floor is a statement by the people responsible
        # for the code. Floors beat ceilings, always.
        floor, floor_layer = self._floor_for(rung, path)
        effect = stricter(effect, floor)

        # Step 4. `ask` means "interrupt the human". An unsupervised agent has
        # no human, so `ask` degrades to a hang or a silent auto-answer.
        # Promoting it to `deny` gives the model the structured brief and four
        # moves instead, which it can act on. Self-declarable because it can
        # only ever tighten.
        promoted = False
        if unattended and effect == "ask":
            effect = "deny"
            promoted = True

        return Resolution(
            rung=rung,
            path=path,
            effect=effect,
            base=base,
            winning_layer=winning_layer,
            winning_rule=winning_rule,
            ceiling=ceiling,
            floor=floor,
            floor_layer=floor_layer,
            unattended_promoted=promoted,
            problems=tuple(problems),
            source=source,
        )

    def table_for(self, path: str, *, unattended: bool = False) -> EffectTable:
        return EffectTable(
            tuple(self.resolve(r, path, unattended=unattended).effect for r in RUNGS)
        )

    def floor_table(self, path: str) -> EffectTable:
        return EffectTable(tuple(self._floor_for(r, path)[0] for r in RUNGS))


# -- parsing -----------------------------------------------------------------

_RUNG_KEY = re.compile(r"rung([0-4])\Z")


def _rung_effects(
    table: Mapping[str, object], source: str, where: str
) -> tuple[dict[int, Effect], list[str]]:
    """Read rung keys off one TOML table. One bad key, one problem line."""
    out: dict[int, Effect] = {}
    problems: list[str] = []
    for key, value in table.items():
        match = _RUNG_KEY.fullmatch(str(key))
        if match is None:
            problems.append(
                f"{source}: {where}: unknown key {key!r}; expected rung0..rung4"
            )
            continue
        if not isinstance(value, str) or value not in RANK:
            problems.append(
                f"{source}: {where}: {key} = {value!r} is not one of "
                f"{', '.join(EFFECTS)}; falling back to the default"
            )
            continue
        out[int(match.group(1))] = value  # type: ignore[assignment]
    return out, problems


def _path_rules(
    entries: object, source: str, where: str, *, is_floor: bool, start: int
) -> tuple[list[Rule], list[str], int]:
    rules: list[Rule] = []
    problems: list[str] = []
    order = start

    if entries is None:
        return rules, problems, order
    if not isinstance(entries, list):
        problems.append(f"{source}: {where} must be an array of tables; ignored")
        return rules, problems, order

    for index, entry in enumerate(entries):
        label = f"{where}[{index}]"
        if not isinstance(entry, dict):
            problems.append(f"{source}: {label} must be a table; ignored")
            continue
        match = entry.get("match")
        if not isinstance(match, str) or not match:
            problems.append(
                f"{source}: {label} has no usable `match` glob; ignored"
            )
            continue
        if not valid_glob(match):
            problems.append(
                f"{source}: {label}: {match!r} is not a valid glob; ignored"
            )
            continue
        effects, probs = _rung_effects(
            {k: v for k, v in entry.items() if k != "match"},
            source,
            f"{where} {match}",
        )
        problems.extend(probs)
        if effects:
            rules.append(
                Rule(match=match, effects=effects, is_floor=is_floor, order=order)
            )
            order += 1
    return rules, problems, order


def parse_layer(text: str, *, name: LayerName, source: str) -> Layer:
    """Never raises. Every bad field falls back and appends one problem line."""
    problems: list[str] = []

    try:
        data = tomllib.loads(text)
    except Exception as exc:  # tomllib raises TOMLDecodeError, but be total
        problems.append(f"{source}: could not be read as TOML: {exc}")
        return Layer(
            name=name, source=source, mode="normal", rules=(),
            problems=tuple(problems), parsed=False,
        )

    schema = data.get("schema", SCHEMA_VERSION)
    if schema != SCHEMA_VERSION:
        # Parsed as v1 anyway. Refusing the file would drop protection, which is
        # the one thing a bad config must never be able to do.
        problems.append(
            f"{source}: schema = {schema!r}, expected {SCHEMA_VERSION}; "
            f"read as schema {SCHEMA_VERSION}"
        )

    mode = data.get("mode", "normal")
    if mode not in MODES:
        problems.append(
            f"{source}: mode = {mode!r} is not one of {', '.join(MODES)}; "
            f"using normal"
        )
        mode = "normal"

    rules: list[Rule] = []
    order = 0

    effects_table = data.get("effects")
    if effects_table is not None:
        if not isinstance(effects_table, dict):
            problems.append(f"{source}: [effects] must be a table; ignored")
        else:
            effects, probs = _rung_effects(effects_table, source, "[effects]")
            problems.extend(probs)
            if effects:
                rules.append(
                    Rule(match=None, effects=effects, is_floor=False, order=order)
                )
                order += 1

    path_rules, probs, order = _path_rules(
        data.get("path"), source, "[[path]]", is_floor=False, start=order
    )
    rules.extend(path_rules)
    problems.extend(probs)

    floor_table = data.get("floor")
    if floor_table is not None:
        if name not in FLOOR_LAYERS:
            problems.append(
                f"{source}: [floor] is only honoured in the org and repo "
                f"layers; ignored in the {name} layer"
            )
        elif not isinstance(floor_table, dict):
            problems.append(f"{source}: [floor] must be a table; ignored")
        else:
            blanket, probs = _rung_effects(
                {k: v for k, v in floor_table.items() if k != "path"},
                source,
                "[floor]",
            )
            problems.extend(probs)
            if blanket:
                rules.append(
                    Rule(match=None, effects=blanket, is_floor=True, order=order)
                )
                order += 1
            floor_paths, probs, order = _path_rules(
                floor_table.get("path"), source, "[[floor.path]]",
                is_floor=True, start=order,
            )
            rules.extend(floor_paths)
            problems.extend(probs)

    return Layer(
        name=name, source=source, mode=mode, rules=tuple(rules),
        problems=tuple(problems),
    )


def load_layer(path: Path | str | None, *, name: LayerName) -> Layer | None:
    """A layer off disk. None when there is no file there.

    "No file" is not a problem and never sets degraded — it is the documented
    default, and it is what almost every machine looks like. Anything else that
    goes wrong reading it is.
    """
    if path is None:
        return None
    target = Path(path)
    try:
        text = target.read_text(encoding="utf-8")
    except FileNotFoundError:
        return None
    except IsADirectoryError:
        return Layer(
            name=name, source=str(target), mode="normal", rules=(),
            problems=(f"{target}: is a directory, not a policy file",),
            parsed=False,
        )
    except OSError as exc:
        return Layer(
            name=name, source=str(target), mode="normal", rules=(),
            problems=(f"{target}: cannot be read: {exc}",), parsed=False,
        )
    except UnicodeDecodeError as exc:
        return Layer(
            name=name, source=str(target), mode="normal", rules=(),
            problems=(f"{target}: is not UTF-8 text: {exc}",), parsed=False,
        )
    return parse_layer(text, name=name, source=str(target))


# -- discovery ---------------------------------------------------------------


def org_policy_path(env: Mapping[str, str] | None = None) -> Path:
    env = os.environ if env is None else env
    return Path(env.get(ORG_POLICY_ENV) or ORG_POLICY_DEFAULT)


def repo_policy_path(
    repo_root: str | None = None, env: Mapping[str, str] | None = None
) -> Path:
    env = os.environ if env is None else env
    root = repo_root or env.get(REPO_ROOT_ENV) or os.getcwd()
    return Path(root) / REPO_POLICY_RELPATH


def user_policy_path(env: Mapping[str, str] | None = None) -> Path:
    env = os.environ if env is None else env
    config = env.get("XDG_CONFIG_HOME")
    base = Path(config) if config else Path(env.get("HOME", "~")).expanduser() / ".config"
    return base / USER_POLICY_RELPATH


def session_policy_path(env: Mapping[str, str] | None = None) -> Path | None:
    env = os.environ if env is None else env
    raw = env.get(SESSION_POLICY_ENV)
    return Path(raw) if raw else None


def _session_env_effects(
    env: Mapping[str, str]
) -> tuple[dict[int, Effect], list[str]]:
    effects: dict[int, Effect] = {}
    problems: list[str] = []
    for rung in RUNGS:
        raw = env.get(f"{SESSION_RUNG_ENV}{rung}")
        if raw is None or not raw.strip():
            continue
        value = raw.strip().lower()
        if value not in RANK:
            problems.append(
                f"<env>: {SESSION_RUNG_ENV}{rung} = {raw!r} is not one of "
                f"{', '.join(EFFECTS)}; ignored"
            )
            continue
        effects[rung] = value  # type: ignore[assignment]
    return effects, problems


def _session_layer(env: Mapping[str, str]) -> Layer | None:
    """The session layer: a file, plus per-rung env vars that beat it.

    The env vars fold into the layer's blanket rule rather than arriving as
    rules of their own. Two blanket rules in one layer would be an exact
    specificity tie, and warning about a tie the user did not write would be
    noise. A `[[path]]` rule in the session file still beats them, which is the
    same "specificity inside a layer" rule everything else follows.
    """
    path = session_policy_path(env)
    layer = load_layer(path, name="session") if path is not None else None
    env_effects, env_problems = _session_env_effects(env)

    if layer is None:
        if not env_effects and not env_problems:
            return None
        return Layer(
            name="session", source="<env>", mode="normal",
            rules=(
                (Rule(match=None, effects=env_effects, is_floor=False, order=0),)
                if env_effects else ()
            ),
            problems=tuple(env_problems),
        )

    if not env_effects and not env_problems:
        return layer

    rules = list(layer.rules)
    for index, rule in enumerate(rules):
        if rule.match is None and not rule.is_floor:
            merged = dict(rule.effects)
            merged.update(env_effects)
            rules[index] = replace(rule, effects=merged)
            break
    else:
        rules.insert(0, Rule(match=None, effects=env_effects, is_floor=False, order=-1))

    return replace(
        layer,
        source=f"{layer.source} + <env>",
        rules=tuple(rules),
        problems=layer.problems + tuple(env_problems),
    )


def digest_of(layers: Sequence[Layer]) -> str:
    """sha256 over everything that could change an answer.

    Sources are in it as well as rules: two identical tables read from two
    different files are the same policy but not the same configuration, and
    `ap doctor` reporting drift needs to be able to tell them apart.
    """
    digest = hashlib.sha256()
    for layer in layers:
        digest.update(f"{layer.name}\x00{layer.source}\x00{layer.mode}\x00".encode())
        for rule in sorted(layer.rules, key=lambda r: r.order):
            digest.update(
                f"{rule.match}\x00{rule.is_floor}\x00"
                f"{sorted(rule.effects.items())}\x00".encode()
            )
    return digest.hexdigest()


def build_policy(layers: Sequence[Layer], *, loaded_at: float = 0.0) -> Policy:
    problems = tuple(p for layer in layers for p in layer.problems)
    return Policy(
        layers=tuple(layers),
        digest=digest_of(layers),
        loaded_at=loaded_at,
        degraded=bool(problems),
        problems=problems,
    )


DEFAULT_INCLUDE: tuple[LayerName, ...] = ("builtin", "repo", "user", "session")
RELAY_INCLUDE: tuple[LayerName, ...] = ("builtin", "org")


def discover(
    repo_root: str | None = None,
    *,
    env: Mapping[str, str] | None = None,
    include: Collection[LayerName] = DEFAULT_INCLUDE,
    loaded_at: float = 0.0,
) -> Policy:
    """Client-side layers by default. The relay passes ``include=RELAY_INCLUDE``.

    The split is not an optimisation. ``org`` is owned by whoever runs the relay
    and is the only floor the relay can enforce; ``repo``, ``user`` and
    ``session`` are files on the client's disk that the relay cannot see and has
    no business guessing at.
    """
    env = os.environ if env is None else env
    layers: list[Layer] = []

    if "builtin" in include:
        layers.append(builtin_layer())
    if "org" in include:
        layer = load_layer(org_policy_path(env), name="org")
        if layer is not None:
            layers.append(layer)
    if "repo" in include:
        layer = load_layer(repo_policy_path(repo_root, env), name="repo")
        if layer is not None:
            layers.append(layer)
    if "user" in include:
        layer = load_layer(user_policy_path(env), name="user")
        if layer is not None:
            layers.append(layer)
    if "session" in include:
        layer = _session_layer(env)
        if layer is not None:
            layers.append(layer)

    policy = build_policy(layers, loaded_at=loaded_at)
    for problem in policy.problems:
        log.warning("policy: %s", problem)
    return policy


# -- the runtime cache the daemon reads --------------------------------------


def runtime_cache_path(env: Mapping[str, str] | None = None) -> Path:
    env = os.environ if env is None else env
    base = env.get("XDG_RUNTIME_DIR") or tempfile.gettempdir()
    return Path(base) / RUNTIME_CACHE_NAME


def compile_runtime(
    policy: Policy, *, path: str = "", unattended: bool = False
) -> dict:
    """The blob the daemon reads.

    Deliberately tiny and deliberately pre-resolved: no TOML, no globs, no
    layers. The daemon stats one file on a tick it already runs and parses only
    when the mtime moves, so a decision costs a shared lock and an array index.
    """
    return {
        "schema": SCHEMA_VERSION,
        "table": policy.table_for(path, unattended=unattended).names(),
        "floor": policy.floor_table(path).names(),
        "digest": policy.digest,
        "degraded": policy.degraded,
        "problem": policy.problems[0] if policy.problems else "",
        "path": path,
        "unattended": unattended,
        "sources": [f"{layer.name}:{layer.source}" for layer in policy.layers],
    }


def write_runtime_cache(dest: Path | str, blob: dict) -> None:
    """Atomic: temp file in the same dir, fsync, rename.

    Same discipline as write_snapshot on the C++ side, for the same reason: the
    daemon reads this on a tick with no locking, and half a file is worse than
    an old one.
    """
    target = Path(dest)
    target.parent.mkdir(parents=True, exist_ok=True)
    handle = tempfile.NamedTemporaryFile(
        mode="w", encoding="utf-8", dir=target.parent,
        prefix=target.name + ".", suffix=".tmp", delete=False,
    )
    try:
        with handle:
            handle.write(json.dumps(blob, separators=(",", ":")) + "\n")
            handle.flush()
            os.fsync(handle.fileno())
        os.chmod(handle.name, 0o644)
        os.replace(handle.name, target)
    except BaseException:
        with_suppressed = Path(handle.name)
        if with_suppressed.exists():
            with_suppressed.unlink(missing_ok=True)
        raise


# -- live reload -------------------------------------------------------------


class PolicyFile:
    """A Policy that notices when its files change.

    ``stat`` is gated by ``RECHECK_S`` and the files are only re-read when an
    mtime or a size moves, so the steady-state cost of live reload is one stat
    per input per second. Editing the file *is* the interface — there is nothing
    to restart, and nothing to remember to restart.

    A file that stops parsing keeps the last good Policy and marks it degraded.
    That is the fail-open/fail-safe split in one line: a typo at 3am must not
    quietly turn protection off, and it must not wedge anything either.
    """

    def __init__(
        self,
        paths: Sequence[Path | str | tuple[str, Path | str]],
        clock: Clock,
        *,
        include_builtin: bool = True,
    ) -> None:
        # A bare path is an org layer: that is the relay's case, and the relay
        # is the only caller that has ever wanted one file with no layer name.
        self._entries: list[tuple[LayerName, Path]] = []
        for entry in paths:
            if isinstance(entry, tuple):
                name, raw = entry
                self._entries.append((name, Path(raw)))  # type: ignore[arg-type]
            else:
                self._entries.append(("org", Path(entry)))
        self._clock = clock
        self._include_builtin = include_builtin
        self._policy: Policy | None = None
        self._checked_at: float | None = None
        self._stamps: dict[Path, tuple[float, int] | None] = {}

    @classmethod
    def for_relay(
        cls, clock: Clock, *, env: Mapping[str, str] | None = None
    ) -> "PolicyFile":
        return cls([("org", org_policy_path(env))], clock)

    @classmethod
    def for_client(
        cls,
        clock: Clock,
        *,
        repo_root: str | None = None,
        env: Mapping[str, str] | None = None,
    ) -> "PolicyFile":
        env = os.environ if env is None else env
        entries: list[tuple[str, Path]] = [
            ("repo", repo_policy_path(repo_root, env)),
            ("user", user_policy_path(env)),
        ]
        session = session_policy_path(env)
        if session is not None:
            entries.append(("session", session))
        return cls(entries, clock)

    @staticmethod
    def _stamp(path: Path) -> tuple[float, int] | None:
        try:
            info = path.stat()
        except OSError:
            return None
        return (info.st_mtime, info.st_size)

    def current(self) -> Policy:
        now = self._clock.now()
        if self._policy is not None and self._checked_at is not None:
            if now - self._checked_at < RECHECK_S:
                return self._policy
        self._checked_at = now

        stamps = {path: self._stamp(path) for _name, path in self._entries}
        if self._policy is not None and stamps == self._stamps:
            return self._policy
        self._stamps = stamps

        layers: list[Layer] = [builtin_layer()] if self._include_builtin else []
        broken: list[Layer] = []
        for name, path in self._entries:
            layer = load_layer(path, name=name)
            if layer is None:
                continue
            if not layer.parsed:
                broken.append(layer)
            layers.append(layer)

        if broken and self._policy is not None:
            # Hold the last good table and say so. Reparsing to builtin here
            # would be a silent drop in protection, which is the one outcome a
            # typo is not allowed to produce.
            extra = tuple(p for layer in broken for p in layer.problems)
            for problem in extra:
                log.warning("policy: %s; keeping the last good table", problem)
            self._policy = replace(
                self._policy,
                loaded_at=now,
                degraded=True,
                problems=self._policy.problems + extra,
            )
            return self._policy

        policy = build_policy(layers, loaded_at=now)
        for problem in policy.problems:
            log.warning("policy: %s", problem)
        self._policy = policy
        return policy


class StaticPolicy:
    """A PolicyFile-shaped wrapper around one fixed Policy. For tests and for
    anything that resolved its layers by other means."""

    def __init__(self, policy: Policy) -> None:
        self._policy = policy

    def current(self) -> Policy:
        return self._policy


BUILTIN_ONLY = build_policy([builtin_layer()])
