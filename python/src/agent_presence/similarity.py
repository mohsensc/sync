"""Intent similarity, for rung 4.

Rungs 0-3 all decide on region overlap: two agents touching the same path, the
same symbol, the same lines. Rung 4 is the case the hooks structurally cannot
see — two agents doing the same work in different files. There is no overlap to
find, so the only evidence available is what each agent *said* it was doing.

That means comparing free text, and free text is where this gets uncomfortable.

## The backend is pluggable on purpose

`LexicalSimilarity` is a BASELINE, not the answer. It is token overlap with a
hand-maintained synonym table, which is to say it knows that "jwt" and "token"
are the same idea because somebody typed that fact into a dict below. It has no
idea that "harden the upload path" and "add checksum verification to uploads"
are the same work, and it never will.

The real backend is sentence embeddings. That is not buildable here: no
external API can be provisioned, and a local transformer would put a
several-hundred-megabyte dependency underneath a component that has to fail
open in a hook's 5ms budget. So the interface is the deliverable and the
lexical scorer is what fills it today.

An embedding backend drops in by registering a factory:

    register_backend("embedding", lambda: MyEmbeddingSimilarity(...))

and setting AGENT_PRESENCE_SIMILARITY=embedding. No call site changes: the
ladder asks for `default_similarity()` and gets whatever is configured.

## Why weights, and why a synonym table

Plain Jaccard on raw tokens scores the canonical true positive - "add JWT
refresh to auth" vs "implement token refresh in the login flow" - at about
0.13. Every content word is a synonym of its partner rather than equal to it,
so the lexical signal is almost entirely in the synonym table.

The weights exist because not all matching tokens are evidence. Nearly every
declared intent opens with an action verb, so "add" matching "add" says close
to nothing; and structural nouns like "endpoint", "module" and "table" appear
in half of all intents. Weighting those down is a stand-in for IDF, which we
cannot compute because there is no corpus at classify time.

See `python/tools/tune_rung4.py` for the pairs these weights were tuned on.
"""

from __future__ import annotations

import math
import os
import re
from collections import Counter
from functools import lru_cache
from typing import Callable, Protocol, runtime_checkable

# -- the interface ----------------------------------------------------------


@runtime_checkable
class IntentSimilarity(Protocol):
    """Two declared intents in, one score in [0, 1] out.

    Contract, so a future backend is substitutable:

    - `score(a, b) == score(b, a)`. The ladder does not know or care which
      agent declared first.
    - Empty or whitespace-only input scores 0.0. "I said nothing" is not
      evidence of anything.
    - Never raises. This sits behind a flag on a path that must fail open; a
      backend that cannot answer returns 0.0, which reads as "no redundancy"
      and costs a missed duplicate rather than a wrong interrupt.
    """

    name: str

    def score(self, a: str, b: str) -> float: ...


# -- lexical backend --------------------------------------------------------

_TOKEN_RE = re.compile(r"[a-z0-9]+")

# Words that carry no signal about *what* is being worked on.
STOPWORDS: frozenset[str] = frozenset({
    "the", "a", "an", "to", "in", "on", "for", "of", "and", "or", "with",
    "from", "at", "by", "into", "that", "this", "it", "is", "are", "be",
    "was", "were", "our", "my", "we", "i", "so", "then", "when", "new",
    "old", "some", "all", "out", "up", "as", "its", "their", "there",
    "here", "do", "does", "please", "also", "just", "now", "per", "via",
    "not", "no", "but", "if", "than", "over", "under", "about", "across",
    "while", "should", "will", "can", "would", "more", "less", "any",
    "each", "both", "how", "what", "why", "where", "who", "one", "two",
    "properly", "correctly", "again", "still", "yet", "currently",
    # Filler verbs. "use JWT" and "using bearer tokens" say the same thing and
    # the word carries none of it; left in, it matches across unrelated pairs
    # at full domain weight.
    "use", "uses", "using", "used", "get", "gets", "getting", "same",
    "only", "much", "many", "very", "really",
})

# Ordered pairs folded before anything else, because the two words together
# mean something neither means apart. Kept short on purpose - every entry is a
# hand-written fact and the list is a maintenance cost, not a feature.
BIGRAMS: dict[tuple[str, str], str] = {
    ("rate", "limit"): "throttle",
    ("rate", "limiting"): "throttle",
    ("rate", "limits"): "throttle",
    ("sign", "in"): "auth",
    ("sign", "on"): "auth",
    ("sign", "up"): "auth",
    ("log", "in"): "auth",
    ("access", "token"): "token",
    ("unit", "test"): "test",
    ("unit", "tests"): "test",
    ("pull", "request"): "pr",
}

# Surface form -> canonical token. This is the whole reason the lexical backend
# clears the bar on the true positives at all, and equally the reason it is a
# baseline: it only knows the synonyms somebody wrote down.
SYNONYMS: dict[str, str] = {}


def _fold(canonical: str, *forms: str) -> None:
    SYNONYMS[canonical] = canonical
    for f in forms:
        SYNONYMS[f] = canonical


# actions
_fold("add", "adds", "adding", "added", "implement", "implements",
      "implementing", "implemented", "create", "creates", "creating",
      "build", "building", "write", "writing", "wrote", "introduce",
      "introducing", "make", "making", "set", "setup", "install")
_fold("fix", "fixes", "fixing", "fixed", "repair", "repairing", "patch",
      "patching", "correct", "correcting", "resolve", "resolving")
_fold("update", "updates", "updating", "updated", "modify", "modifying",
      "change", "changes", "changing", "edit", "editing", "tweak",
      "tweaking", "adjust", "adjusting", "bump", "bumping")
_fold("delete", "deletes", "deleting", "remove", "removes", "removing",
      "removed", "drop", "dropping", "strip", "stripping", "purge")
_fold("refactor", "refactors", "refactoring", "refactored", "restructure",
      "rework", "reworking", "rewrite", "rewriting", "clean", "cleanup",
      "tidy", "simplify", "simplifying")
_fold("migrate", "migrates", "migrating", "migration", "migrations")
_fold("move", "moves", "moving", "moved", "relocate", "port", "porting")
_fold("rename", "renames", "renaming", "renamed")
_fold("handle", "handles", "handling", "handled", "support", "supports",
      "supporting", "cover", "covering")
_fold("wire", "wires", "wiring", "wired", "hook", "hooking", "connect",
      "connecting", "integrate", "integrating")
_fold("check", "checks", "checking", "checked", "verify", "verifying",
      "verification", "assert", "asserting")
_fold("debug", "debugging", "investigate", "investigating", "diagnose")
_fold("enable", "enabling", "disable", "disabling", "toggle")
_fold("split", "splitting", "extract", "extracting", "merge", "merging")
_fold("improve", "improving", "harden", "hardening", "optimize",
      "optimizing", "optimise", "speed", "speeding")

# structural nouns - real words, but they appear everywhere
_fold("endpoint", "endpoints", "route", "routes", "api", "apis", "url",
      "urls", "path", "paths")
_fold("module", "modules", "package", "packages", "lib", "library")
_fold("table", "tables")
_fold("page", "pages", "screen", "screens", "view", "views")
_fold("file", "files")
_fold("function", "functions", "method", "methods", "func", "fn")
_fold("class", "classes")
_fold("test", "tests", "testing", "spec", "specs", "unittest", "coverage")
_fold("flow", "flows", "pipeline", "pipelines")
_fold("config", "configs", "configuration", "settings", "setting", "option",
      "options")
_fold("handler", "handlers", "controller", "controllers")
_fold("service", "services", "server", "servers", "worker", "workers")
_fold("component", "components", "widget", "widgets")
_fold("form", "forms", "field", "fields", "input", "inputs")
_fold("list", "lists", "item", "items", "row", "rows")
_fold("job", "jobs", "task", "tasks")
_fold("script", "scripts")
_fold("layer", "layers", "wrapper", "wrappers")
_fold("request", "requests", "call", "calls", "response", "responses")
_fold("code", "codebase")
_fold("data", "value", "values")
_fold("error", "errors", "exception", "exceptions", "failure", "failures")

# domain nouns - what the work is actually about
_fold("token", "tokens", "jwt", "jwts", "bearer", "credential", "credentials")
_fold("auth", "authentication", "authorization", "authorisation", "authn",
      "authz", "login", "logins", "signin", "signup", "session", "sessions",
      "logout", "signout")
_fold("refresh", "refreshes", "refreshing", "renew", "renewal", "renewing",
      "reissue", "rotate", "rotation", "rotating")
_fold("retry", "retries", "retrying", "reattempt")
_fold("backoff", "jitter")
_fold("upload", "uploads", "uploader", "uploading", "uploaded")
_fold("download", "downloads", "downloader", "downloading")
_fold("cache", "caches", "caching", "cached", "memoize", "memoization")
_fold("paginate", "pagination", "paging", "paginated", "cursor")
_fold("throttle", "throttling", "ratelimit", "ratelimiting", "quota")
_fold("log", "logs", "logging", "logger", "telemetry", "trace", "tracing")
_fold("metric", "metrics", "instrument", "instrumentation")
_fold("validate", "validates", "validation", "validator", "validating",
      "sanitize", "sanitizing")
_fold("db", "database", "databases", "postgres", "sql")
_fold("query", "queries", "querying", "lookup", "lookups", "fetch",
      "fetching", "read", "reads")
_fold("index", "indexes", "indices", "indexing")
_fold("css", "style", "styles", "styling", "stylesheet", "scss", "tailwind")
_fold("layout", "layouts", "grid", "flexbox", "spacing", "alignment")
_fold("docs", "doc", "documentation", "readme", "changelog")
_fold("deploy", "deploys", "deployment", "deployments", "deploying",
      "release", "releases", "ship", "shipping")
_fold("webhook", "webhooks", "callback", "callbacks")
_fold("payment", "payments", "checkout", "charge", "charges")
_fold("billing", "invoice", "invoices", "subscription", "subscriptions")
_fold("user", "users", "account", "accounts", "profile", "profiles")
_fold("order", "orders", "purchase", "purchases")
_fold("notification", "notifications", "notify", "alert", "alerts", "email",
      "emails")
_fold("schema", "schemas", "model", "models")
_fold("timezone", "timezones", "tz", "datetime", "timestamp", "timestamps")
_fold("search", "searching", "lookup", "filter", "filters", "filtering")
_fold("permission", "permissions", "role", "roles", "acl", "scope", "scopes")
_fold("websocket", "websockets", "ws", "socket", "sockets")
_fold("queue", "queues", "queueing", "buffer", "buffering")

# Nothing more expensive than a dict lookup runs on the hot path, so the
# morphological fallback stays crude on purpose: plurals and the handful of
# common verb endings. Each suffix carries its own minimum stem length, which
# is the only thing keeping it from mangling short words - "user" must not
# become "us", and "-er" is the greedy one, so it asks for more left over.
_SUFFIXES: tuple[tuple[str, str, int], ...] = (
    ("ies", "y", 4),
    ("ing", "", 4),
    ("ed", "", 4),
    ("er", "", 5),
    ("es", "", 4),
    ("s", "", 4),
)


def _stem(token: str) -> str:
    if token in SYNONYMS:
        return SYNONYMS[token]
    for suffix, replacement, floor in _SUFFIXES:
        if token.endswith(suffix) and len(token) - len(suffix) >= floor:
            stem = token[: len(token) - len(suffix)] + replacement
            return SYNONYMS.get(stem, stem)
    return token


# Weight tiers. A shared token is only evidence in proportion to how much it
# narrows down what the work is.
VERB_WEIGHT = 0.3       # every intent has one; matching says nearly nothing
GENERIC_WEIGHT = 0.5    # "endpoint", "module", "table" - true of half of them
DOMAIN_WEIGHT = 1.0     # what the work is actually about

_VERBS: frozenset[str] = frozenset({
    "add", "fix", "update", "delete", "refactor", "migrate", "move",
    "rename", "handle", "wire", "check", "debug", "enable", "split",
    "improve",
})

_GENERIC: frozenset[str] = frozenset({
    "endpoint", "module", "table", "page", "file", "function", "class",
    "test", "flow", "config", "handler", "service", "component", "form",
    "list", "job", "script", "layer", "request", "code", "data", "error",
})


def weight(token: str) -> float:
    if token in _VERBS:
        return VERB_WEIGHT
    if token in _GENERIC:
        return GENERIC_WEIGHT
    return DOMAIN_WEIGHT


# redundant_peer (ladder.py) calls score(intent, o.intent) once per peer, and
# `intent` - the incoming side - is the same string on every one of those
# calls. Cache the tokenizer so that constant side costs one regex pass per
# room, not one per peer: ~0.34ms -> ~0.06ms at 5 peers, ~8.4ms -> ~0.4ms at
# 200 peers, measured with tools/bench_redundant_peer.py. Bounded so a relay
# that lives for days doesn't grow this without limit; 4096 is generously
# above any plausible room's worth of distinct declared intents.
@lru_cache(maxsize=4096)
def _tokens_cached(text: str) -> tuple[str, ...]:
    raw = _TOKEN_RE.findall(text.lower())

    folded: list[str] = []
    i = 0
    while i < len(raw):
        if i + 1 < len(raw):
            pair = BIGRAMS.get((raw[i], raw[i + 1]))
            if pair is not None:
                folded.append(pair)
                i += 2
                continue
        folded.append(raw[i])
        i += 1

    out: list[str] = []
    for token in folded:
        if token in STOPWORDS or len(token) < 2:
            continue
        stemmed = _stem(token)
        if stemmed and stemmed not in STOPWORDS:
            out.append(stemmed)
    return tuple(out)


def tokens(text: str) -> list[str]:
    """Normalise, drop stopwords, fold bigrams, then fold and stem.

    Returns a list rather than a set: repetition is mild evidence of emphasis
    and the cosine below uses the counts. Backed by a cache keyed on the raw
    text - see `_tokens_cached` - so callers should feel free to call this
    more than once on the same string.
    """
    return list(_tokens_cached(text))


# Floors, checked before the cosine. They exist because cosine on a two-token
# intent is all-or-nothing: "fix auth" against "fix auth" scores 1.0 on one
# shared idea, which is not enough to spend an interrupt on.
MIN_TOKENS = 2            # per side, after folding
MIN_SHARED_NON_VERB = 2   # tokens in common that are not action verbs
MIN_SHARED_DOMAIN = 1     # at least one of those has to name the subject


class LexicalSimilarity:
    """Weighted-cosine token overlap. Dependency-free, deterministic, cheap.

    Baseline. It matches synonyms it was told about and nothing else, so it
    misses paraphrase ("harden the upload path" vs "add checksum verification
    to uploads" scores 0) and it cannot tell two structurally identical
    intents apart when only a proper noun differs. Both failure modes are
    argued about in `python/tools/tune_rung4.py`; the second is why the
    default threshold is where it is.
    """

    name = "lexical"

    def score(self, a: str, b: str) -> float:
        try:
            ta, tb = _tokens_cached(a), _tokens_cached(b)
        except Exception:  # pragma: no cover - fail open, never raise
            return 0.0
        if len(ta) < MIN_TOKENS or len(tb) < MIN_TOKENS:
            return 0.0

        shared = set(ta) & set(tb)
        non_verb = [t for t in shared if t not in _VERBS]
        if len(non_verb) < MIN_SHARED_NON_VERB:
            return 0.0
        if sum(1 for t in non_verb if weight(t) >= DOMAIN_WEIGHT) < MIN_SHARED_DOMAIN:
            return 0.0

        ca, cb = Counter(ta), Counter(tb)
        dot = sum(ca[t] * cb[t] * weight(t) ** 2 for t in shared)
        na = math.sqrt(sum((n * weight(t)) ** 2 for t, n in ca.items()))
        nb = math.sqrt(sum((n * weight(t)) ** 2 for t, n in cb.items()))
        if na == 0.0 or nb == 0.0:
            return 0.0
        return min(1.0, dot / (na * nb))


# -- backend selection ------------------------------------------------------

BACKEND_ENV = "AGENT_PRESENCE_SIMILARITY"
DEFAULT_BACKEND = "lexical"

_BACKENDS: dict[str, Callable[[], IntentSimilarity]] = {
    "lexical": LexicalSimilarity,
}
_INSTANCES: dict[str, IntentSimilarity] = {}


def register_backend(name: str, factory: Callable[[], IntentSimilarity]) -> None:
    """Make a backend selectable by name.

    This is the seam an embedding scorer arrives through. It registers itself,
    the operator sets AGENT_PRESENCE_SIMILARITY, and no call site in the ladder
    or the relay changes.
    """
    _BACKENDS[name] = factory
    _INSTANCES.pop(name, None)


def default_similarity() -> IntentSimilarity:
    """The configured backend, built once per name.

    An unknown name falls back to lexical rather than raising. This is on a
    path that must fail open: a typo in an env var should cost accuracy, not
    the relay.
    """
    name = os.environ.get(BACKEND_ENV, "").strip().lower() or DEFAULT_BACKEND
    if name not in _BACKENDS:
        name = DEFAULT_BACKEND
    instance = _INSTANCES.get(name)
    if instance is None:
        instance = _BACKENDS[name]()
        _INSTANCES[name] = instance
    return instance
