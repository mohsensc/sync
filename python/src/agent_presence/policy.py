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

# Mirrors what redact.py used to export as OPAQUE_ENV, back when this
# module imported it from there. redact.py existed to serve the Python
# relay, which is gone (#40) — this is the one thing this file still
# needs from it, so it's inlined here rather than keeping a whole module
# alive for one constant.
OPAQUE_ENV = "AGENT_PRESENCE_OPAQUE"

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
#
# Rung 4 defaults to `context`, not `silent`. It has its own off switch already
# - AGENT_PRESENCE_RUNG4, off unless you set it - and a second one here would
# mean turning the feature on and getting silence with nothing to say why. So
# the flag decides whether rung 4 runs and this decides how loudly a hit is
# reported: `context` tells the agent without spending anybody's attention.
BUILTIN = EffectTable(("silent", "notify", "context", "deny", "context"))

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


# -- what a path is, before a glob is allowed near it -------------------------
#
# Every glob anybody writes is repo-relative. `[[path]] match = "src/pay.py"`
# is what the docs show, what `ap policy explain src/pay.py` takes, and what
# people mean. What arrives at a decision is not always that shape, and until
# this section existed the mismatch was silent:
#
#   src/payments/charge.py                       what was written down
#   /Users/sara/work/repo/src/payments/charge.py what the hook sends (PreToolUse
#                                                carries file_path absolute)
#   de56cd6b6439220c                             what the relay holds in opaque
#                                                mode (redact.opaque_region)
#
# The first matched. The other two matched nothing, so every [[path]] rule and
# every [[floor.path]] rule quietly stopped existing and the blanket answered
# instead. The floor a repo wrote to make `**/pay.py` deny came back `notify`
# for the same file, and nothing anywhere said so.
#
# Normalisation belongs here rather than at each caller because "which paths
# does this glob cover" is a question about globs, and this is the only file
# that knows the answer. The three shapes are handled by reading, not guessing:
#
#   rooted     a relative path. Matched as written.
#   unrooted   an absolute path. The checkout root is not knowable here — the
#              relay never learns it and must not, and one policy file is read
#              on machines that clone to different places — so a repo-relative
#              glob is tried against every tail of it. `src/payments/**` covers
#              `/Users/sara/work/repo/src/payments/charge.py` because that IS
#              `src/payments/charge.py` under some root.
#   opaque     a hash. No glob can ever match one, so there is no reading that
#              tells the truth, and the honest answer is the strictest thing
#              any rule could have said. See `_OPAQUE`.
#
# Where more than one reading is possible the strictest one wins. A path we are
# not certain about must not come out quieter than the same path spelled the way
# the policy file spells it — that is the direction the old behaviour failed in.

_SEPS = re.compile(r"/{2,}")

# A path redact.opaque_region produced: sha256 truncated to 16 hex characters,
# and nothing else — no separator, no dot. A real file called `deadbeefcafe1234`
# at the repo root reads as opaque too. It gets the strictest reading of the
# rules rather than the blanket, which is the safe direction to be wrong in, and
# renaming it is a one-line fix for anybody who trips over it.
_OPAQUE = re.compile(r"[0-9a-f]{16}\Z")


def normalize_path(path: str, *, root: str | None = None) -> str:
    """One spelling of a path, for matching against a repo-relative glob.

    Collapses ``//``, drops ``./`` and any trailing slash, and — when the
    caller knows the checkout root — makes an absolute path relative to it.
    ``root`` is how a caller that *does* know (``ap`` knows: see
    ``cli.find_repo_root``) gets an exact match instead of the tail-matching
    fallback below.
    """
    text = (path or "").strip()
    if not text:
        return ""
    text = _SEPS.sub("/", text)
    while text.startswith("./"):
        text = text[2:]
    if len(text) > 1:
        text = text.rstrip("/")
    if root:
        base = _SEPS.sub("/", root.strip()).rstrip("/")
        if base and text.startswith(base + "/"):
            text = text[len(base) + 1:]
    return text


def path_is_opaque(path: str) -> bool:
    """True for a path `redact.opaque_region` hashed. No glob matches one."""
    return bool(_OPAQUE.fullmatch(path))


def _readings(path: str) -> tuple[str, ...]:
    """Every spelling of ``path`` a repo-relative glob may be tried against,
    most literal first. One entry for an ordinary relative path.

    An absolute path is every tail of itself at a directory boundary, because
    exactly one of those tails is the repo-relative path and this side cannot
    tell which. The absolute form stays in the list first, so a policy file
    that really does pin an absolute glob keeps working.
    """
    if not path.startswith("/"):
        return (path,)
    out = [path]
    rest = path.lstrip("/")
    while rest:
        out.append(rest)
        cut = rest.find("/")
        if cut == -1:
            break
        rest = rest[cut + 1:]
    return tuple(out)


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

    def _floor_at(self, rung: int, path: str) -> tuple[Effect, LayerName | None]:
        """The floor for one exact spelling of a path."""
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

    def _floor_anywhere(self, rung: int) -> tuple[Effect, LayerName | None]:
        """The strictest floor any rule in this policy sets for the rung, for a
        path no glob can be matched against at all.

        A floor is "this never goes below". A path we cannot read is not a
        reason to go below it, so an unreadable path gets the strictest floor
        that could have applied rather than the blanket one. That is what makes
        opaque mode a privacy setting instead of a policy switch: hashing the
        path hides the filename from the relay, and it does not buy a quieter
        answer for the file.
        """
        floor: Effect = BUILTIN_FLOOR[rung]
        source: LayerName | None = None
        for layer in self._ordered():
            if layer.name not in FLOOR_LAYERS:
                continue
            for rule in layer.rules:
                if not rule.is_floor:
                    continue
                candidate = rule.effects.get(_rung_index(rung))
                if candidate is not None and RANK[candidate] > RANK[floor]:
                    floor, source = candidate, layer.name
        return floor, source

    def _has_path_rules(self) -> bool:
        """Does anything here name a path at all? Cheap — a handful of rules —
        and it keeps the reading machinery off the shipped default, where every
        rule is a blanket and every spelling of a path answers alike."""
        return any(
            rule.match is not None
            for layer in self.layers
            for rule in layer.rules
        )

    def _touches(self, path: str) -> bool:
        """Does any glob in this policy match this exact spelling of a path?"""
        return any(
            rule.match is not None and rule.matches(path)
            for layer in self.layers
            for rule in layer.rules
        )

    def _floor_for(self, rung: int, path: str) -> tuple[Effect, LayerName | None]:
        """The floor for a path in whatever shape it arrived in.

        Strictest reading wins: an absolute path is floored by any rule that
        covers any tail of it, and an opaque one by any rule at all. See the
        `_readings` block above for why there is more than one reading.
        """
        path = normalize_path(path)
        if path_is_opaque(path):
            return self._floor_anywhere(rung)
        best = self._floor_at(rung, path)
        for alt in _readings(path)[1:]:
            candidate = self._floor_at(rung, alt)
            if RANK[candidate[0]] > RANK[best[0]]:
                best = candidate
        return best

    def _ordered(self) -> list[Layer]:
        return sorted(
            self.layers,
            key=lambda layer: LAYER_ORDER.index(layer.name)
            if layer.name in LAYER_ORDER else 0,
        )

    def resolve(self, rung: int, path: str, *, unattended: bool = False) -> Resolution:
        """What happens at this rung on this path.

        The path is normalised first and may have more than one honest reading
        — see the `_readings` block. Where it does, the strictest reading wins:
        a path this side cannot pin down exactly must not come out quieter than
        the same file spelled the way the policy file spells it.
        """
        rung = _rung_index(rung)
        path = normalize_path(path)

        if path_is_opaque(path):
            return self._resolve_opaque(rung, path, unattended=unattended)

        best = self._resolve_at(rung, path, unattended=unattended)
        if not self._has_path_rules():
            # Nothing in this policy can tell two spellings of a path apart, so
            # there is no second reading to take. The shipped default is here —
            # a stack with no `[[path]]` line in it pays one resolution, which
            # is what it paid before any of this existed.
            return best
        # A reading no glob in this policy touches resolves the same way every
        # other untouched reading does — to the blanket answer — so it is worth
        # computing once and comparing rather than resolving per tail. That is
        # most tails: `/Users/sara/work/repo/src/pay.py` has seven and one of
        # them is the file.
        blanket: Resolution | None = None
        for alt in _readings(path)[1:]:
            if self._touches(alt):
                candidate = self._resolve_at(rung, alt, unattended=unattended)
            else:
                if blanket is None:
                    blanket = self._resolve_at(rung, "", unattended=unattended)
                candidate = blanket
            if RANK[candidate.effect] > RANK[best.effect]:
                # Keep the path the caller asked about. The tail is how the
                # rule was found, not what the agent is editing, and every
                # reader of this — `ap policy explain`, `ap why`, the refusal
                # the model gets — is talking about the file.
                best = replace(candidate, path=path)
        return best

    def _resolve_opaque(
        self, rung: int, path: str, *, unattended: bool = False
    ) -> Resolution:
        """A hashed path. No glob matches one, so every path rule is treated as
        if it might apply and the strictest of them stands.

        The alternative is what shipped: opaque mode turned every ``[[path]]``
        and ``[[floor.path]]`` rule off, silently, for every file. Privacy and
        policy do not compose here and this says which one wins.
        """
        blanket = self._resolve_at(rung, "", unattended=unattended)
        floor, floor_layer = self._floor_anywhere(rung)
        effect = stricter(blanket.base if blanket.ceiling is None else
                          quieter(blanket.base, blanket.ceiling), floor)
        base, layer_name, rule_name, source = (
            blanket.base, blanket.winning_layer, blanket.winning_rule,
            blanket.source,
        )

        for layer in self._ordered():
            ceiling = OBSERVER_CEILING if layer.mode == "observer" else None
            for rule in layer.rules:
                if rule.is_floor or rule.match is None:
                    continue
                candidate = rule.effects.get(rung)
                if candidate is None:
                    continue
                if ceiling is not None:
                    candidate = quieter(candidate, ceiling)
                if RANK[candidate] > RANK[effect]:
                    effect = candidate
                    base, layer_name = candidate, layer.name
                    rule_name, source = rule.describe(), layer.source

        promoted = False
        if unattended and effect == "ask":
            effect, promoted = "deny", True

        return Resolution(
            rung=rung,
            path=path,
            effect=effect,
            base=base,
            winning_layer=layer_name,
            winning_rule=rule_name,
            ceiling=blanket.ceiling,
            floor=floor,
            floor_layer=floor_layer,
            unattended_promoted=promoted,
            problems=blanket.problems + (
                f"{path} is an opaque path ({OPAQUE_ENV}); no glob can "
                f"match a hash, so every path rule was read as if it might "
                f"apply and the strictest one stands",
            ),
            source=source,
        )

    def _resolve_at(
        self, rung: int, path: str, *, unattended: bool = False
    ) -> Resolution:
        """One exact spelling of a path, matched as written."""
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
        #
        # The floor for *this* spelling of the path, not the strictest floor
        # across every spelling: `resolve` is already walking the readings and
        # taking the strictest answer, so asking for them again here would be
        # the same search squared.
        floor, floor_layer = self._floor_at(rung, path)
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

    def floor_rules(self) -> list[dict]:
        """Every path-scoped floor, in the shape the wire carries them.

        ``floor_table`` answers for one path, and the relay does not have one:
        it sends its floor once, on join, and the daemon applies it to every
        file afterwards. So the flat table is what a blanket floor comes to and
        these are the lines it cannot express — ``[[floor.path]] match =
        "**/pay.py"`` and the like. Without them the wire dropped every
        path-scoped floor an org wrote, which is most of what an org writes:
        `floor_table("")` matches no glob, so the frame said `notify` for a file
        the relay itself was denying.

        Five slots per rule, ``""`` where the rule says nothing, so a reader can
        raise rung by rung without knowing which rungs a line mentioned. Order
        does not matter: a floor is the strictest thing that matches, never the
        most specific. ``floor_from_frame`` is the reader, written out so the
        daemon has something to mirror.
        """
        out: list[dict] = []
        for layer in self._ordered():
            if layer.name not in FLOOR_LAYERS:
                continue
            for rule in layer.rules:
                if not rule.is_floor or rule.match is None:
                    continue
                effects = [rule.effects.get(rung, "") for rung in RUNGS]
                if any(effects):
                    out.append({
                        "match": rule.match,
                        "effects": effects,
                        "layer": layer.name,
                    })
        return out


def glob_covers(pattern: str, path: str) -> bool:
    """Does this repo-relative glob cover this path, in whatever shape the path
    turned up in? The one matching rule, in one place, for callers outside the
    layer machinery. See the `_readings` block for the three shapes."""
    compiled = _compile_glob(pattern)
    if compiled is None:
        return False
    path = normalize_path(path)
    if path_is_opaque(path):
        # A hash is not distinguishable from the file the rule names, so a
        # floor written against that file applies. Strictest reading wins.
        return True
    return any(compiled.match(reading) is not None for reading in _readings(path))


def floor_from_frame(frame: Mapping[str, object], path: str) -> EffectTable:
    """The floor a daemon should enforce for one path, out of one relay frame.

    The daemon's half of ``Relay._policy_frame``, written on this side so the
    two halves cannot drift and so a test can drive it. In order:

        start at the builtin floor, which is compiled into both sides;
        raise it with `floor`, the org's blanket floor;
        raise it again with every `floors` entry whose glob covers the path.

    Only ever raises — a floor that could lower something is a default with
    extra steps — so an unknown or malformed field costs the reader nothing and
    a frame from an older relay with no `floors` key behaves exactly as it did.
    """
    table = list(BUILTIN_FLOOR.rungs)

    blanket = frame.get("floor")
    if isinstance(blanket, (list, tuple)) and len(blanket) == len(table):
        for rung, name in enumerate(blanket):
            if isinstance(name, str) and name in RANK:
                table[rung] = stricter(table[rung], name)  # type: ignore[arg-type]

    entries = frame.get("floors")
    if isinstance(entries, (list, tuple)):
        for entry in entries:
            if not isinstance(entry, Mapping):
                continue
            match = entry.get("match")
            effects = entry.get("effects")
            if not isinstance(match, str) or not isinstance(effects, (list, tuple)):
                continue
            if not glob_covers(match, path):
                continue
            for rung, name in enumerate(effects[:len(table)]):
                if isinstance(name, str) and name in RANK:
                    table[rung] = stricter(table[rung], name)  # type: ignore[arg-type]

    return EffectTable(tuple(table))  # type: ignore[arg-type]


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


def runtime_digest(
    policy: Policy, *, path: str = "", unattended: bool = False
) -> str:
    """sha256 over everything that decides what ``compile_runtime`` writes.

    ``policy.digest`` covers the files. It does not cover the two arguments,
    and both of them change the table: a cache compiled ``--unattended`` holds
    ``deny`` where the same files attended hold ``ask``, and a cache pinned to
    one path holds that path's table for every path. With only the file digest
    to compare, ``ap doctor`` said ``ok`` over both — the daemon on a table the
    config on disk does not describe, and the one command whose job is to
    notice reporting green. So the compile arguments are in here too.
    """
    digest = hashlib.sha256()
    digest.update(policy.digest.encode())
    digest.update(b"\x00")
    digest.update(path.encode())
    digest.update(b"\x00")
    digest.update(b"unattended" if unattended else b"attended")
    return digest.hexdigest()


def _compiled_effects(
    rule: Rule, *, ceiling: Effect | None, unattended: bool
) -> list[str]:
    """One rule as five slots, ``""`` where the rule says nothing.

    The ceiling and the unattended promotion are folded in here rather than
    left for the daemon. The ceiling belongs to the layer that won a rung, and
    a rule only appears under its own layer, so applying it per rule is the
    same thing ``resolve`` does. The promotion distributes over the floor —
    ``max`` of two promoted effects is the promotion of their ``max``, since
    the only thing it moves is ``ask``, upward — so per-entry is safe there
    too, and the daemon never has to know which run it is in.
    """
    out: list[str] = []
    for rung in RUNGS:
        effect = rule.effects.get(rung)
        if effect is None:
            out.append("")
            continue
        if ceiling is not None:
            effect = quieter(effect, ceiling)
        if unattended and effect == "ask":
            effect = "deny"
        out.append(effect)
    return out


def _compiled_rules(policy: Policy, *, unattended: bool) -> list[dict]:
    """Every effect rule, flattened into one first-match-wins list.

    Highest-authority layer first, and within a layer most specific first, so
    walking this list and taking the first entry that matches the path *and*
    fills that rung's slot gives exactly what ``Policy.resolve`` gives. The
    builtin blanket is last and matches everything, so the walk always ends.

    ``match`` is ``""`` for a blanket rule, which is a glob nothing else can
    spell.
    """
    out: list[dict] = []
    for layer in reversed(policy._ordered()):
        ceiling: Effect | None = (
            OBSERVER_CEILING if layer.mode == "observer" else None
        )
        ordered = sorted(
            (r for r in layer.rules if not r.is_floor),
            key=lambda r: (r.specificity(), r.order),
            reverse=True,
        )
        for rule in ordered:
            effects = _compiled_effects(
                rule, ceiling=ceiling, unattended=unattended
            )
            if any(effects):
                out.append({
                    "match": rule.match or "",
                    "effects": effects,
                    "layer": layer.name,
                })
    return out


def _compiled_floors(policy: Policy, *, unattended: bool) -> list[dict]:
    """Every floor rule, unordered on purpose.

    A floor is not first-match-wins. The strictest floor that matches applies,
    across layers and within one, so the daemon takes the max over every entry
    that matches plus the blanket ``floor`` array.
    """
    out: list[dict] = []
    for layer in policy._ordered():
        if layer.name not in FLOOR_LAYERS:
            continue
        for rule in layer.rules:
            if not rule.is_floor:
                continue
            effects = _compiled_effects(rule, ceiling=None, unattended=unattended)
            if any(effects):
                out.append({
                    "match": rule.match or "",
                    "effects": effects,
                    "layer": layer.name,
                })
    return out


def compile_runtime(
    policy: Policy, *, path: str = "", unattended: bool = False
) -> dict:
    """The blob the daemon reads.

    Deliberately tiny and deliberately pre-resolved: no TOML, no layers, no
    modes. The daemon stats one file on a tick it already runs and parses only
    when the mtime moves.

    ``table`` and ``floor`` are the blanket answer, resolved for ``path``
    (empty, normally, which no glob matches). ``rules`` and ``floors`` carry
    the ``[[path]]`` globs, which used to be resolved away here and never
    reached the daemon at all: a repo could pin ``**/pay.py`` to ``deny``,
    ``ap policy explain`` would agree, and the daemon would go on serving the
    blanket table because that is all the cache held.

    The daemon's half, for one rung and one path:

        for entry in rules:            # already in priority order
            if matches(entry.match, path) and entry.effects[rung]:
                effect = entry.effects[rung]; break
        else:
            effect = table[rung]
        floor = floor[rung]
        for entry in floors:
            if matches(entry.match, path) and entry.effects[rung]:
                floor = stricter(floor, entry.effects[rung])
        effect = stricter(effect, floor)

    A daemon that reads only ``table`` and ``floor`` — every daemon shipped so
    far — keeps behaving exactly as it did.
    """
    return {
        "schema": SCHEMA_VERSION,
        "table": policy.table_for(path, unattended=unattended).names(),
        "floor": policy.floor_table(path).names(),
        "rules": _compiled_rules(policy, unattended=unattended),
        "floors": _compiled_floors(policy, unattended=unattended),
        "digest": runtime_digest(policy, path=path, unattended=unattended),
        "policy_digest": policy.digest,
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
