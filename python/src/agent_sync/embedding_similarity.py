"""Local sentence-embedding backend for rung 4.

Registers itself as "embedding" against the seam `similarity.py` describes.
Nothing in the default install imports this module - `similarity.py`'s
`default_similarity()` only reaches for it when `AGENT_SYNC_SIMILARITY`
is actually set to "embedding" - so `fastembed` and its dependencies never
land on a machine that hasn't asked for them. Requires the optional extra:

    pip install 'agent-sync[embedding]'

## What this is

`sentence-transformers/all-MiniLM-L6-v2`, run locally through fastembed's
ONNX runtime. No torch, no GPU, no network call per query. The model
(~90MB) downloads once on first use from Hugging Face and is cached under
fastembed's default cache dir after that; every query after the first is
pure local inference. See docs/threat-model.md for the one-time-download
note - it is a fetch of public model weights at setup time, not a per-query
send of anyone's declared intent, but it is still the one point this
component touches the network and it is documented there rather than
silently.

## What the measurement actually says

`python/tools/tune_rung4.py --backend embedding` runs this backend over the
same 23 hand-written pairs `LexicalSimilarity` was tuned against - the only
evaluation data that exists; see that tool's own docstring on why no more
was invented for this. The result: this backend does not beat lexical, and
the way it loses is the interesting part.

Raw cosine similarity on a pooled sentence embedding tracks *template*
similarity, not *entity* similarity. "migrate the users table to the new
schema" and "migrate the orders table to the new schema" score 0.659 with
all-MiniLM-L6-v2 - almost indistinguishable from the true duplicate "add JWT
refresh to auth" / "implement token refresh in the login flow" at 0.654 -
because eight of nine tokens are shared and the one that differs barely
moves a mean-pooled vector. That is exactly the case the NEAR_MISS half of
the tuning corpus exists to catch, and on this corpus neither backend has a
threshold that catches every duplicate with zero false positives - the
weakest duplicate scores below the strongest non-duplicate for both. What
separates them is how bad that gets. Both backends have a "zero-FP floor" -
the tightest threshold with no false positive on this corpus, i.e. just
above the strongest non-duplicate - and what it costs in recall to sit
there:

    backend     zero-FP floor   duplicates caught at that floor
    lexical     0.756           7/8
    embedding   0.798           2/8

Lexical gets almost all its recall back the moment it's FP-safe at all;
embedding gives up 75% of it. (Lexical's *shipped* default, 0.82, sits above
this floor with margin on purpose - see ladder.py - and catches 6/8, still
comfortably ahead.) Swapping in `BAAI/bge-small-en-v1.5` didn't fix it either
(zero-FP floor 0.910, 2/8 duplicates caught there) - this isn't one unlucky
model choice.

So: lexical stays `DEFAULT_BACKEND`. This backend is real, selectable, and
tested, but "swap in sentence embeddings" was not, on its own, the fix this
component's docstring used to assume it would be.

## What would actually settle this

Not tried here, because trying it would mean tuning a design against the
same small fixed corpus until it stopped losing - the thing the tuning
corpus is supposed to catch, done to itself:

- Real captured intent pairs instead of 23 hand-written ones. This corpus is
  small, and the NEAR_MISS half is deliberately adversarial toward exactly
  the failure mode embeddings have; a distribution of real declared intents
  could look nothing like it.
- A scorer that isn't raw pooled cosine - token-level max-similarity between
  the two texts' word embeddings, a cross-encoder, or a model fine-tuned for
  entity-sensitive paraphrase rather than general STS - might not share this
  failure mode. Untested and out of scope here.

If `AGENT_SYNC_SIMILARITY=embedding` is set anyway, `AGENT_SYNC_RUNG4_THRESHOLD`
still applies (it's a ladder-level setting, not per-backend) and 0.82 was
tuned for the lexical backend's score distribution, not this one - expect to
need a different value, and treat whatever you pick as provisional until it
has real traffic behind it.
"""

from __future__ import annotations

import logging
import math
import threading
from functools import lru_cache

# Imported at module level, deliberately: this is what makes `import
# embedding_similarity` raise ImportError when the 'embedding' extra isn't
# installed, which is what lets similarity.py's default_similarity() catch it
# and fall back to lexical with a clear log line instead of silently
# registering a backend that can only ever score 0.0. The model itself is
# not constructed here - that's _get_model()'s job, deferred to first use.
from fastembed import TextEmbedding

from .similarity import register_backend

log = logging.getLogger("agent_sync.embedding_similarity")

MODEL_NAME = "sentence-transformers/all-MiniLM-L6-v2"

_model_lock = threading.Lock()
_model = None


def _get_model():
    """Loaded once per process, on first score() call - not at import or
    registration time. Loading takes several seconds and (on a cold cache)
    downloads the model; nothing about registering this backend should pay
    that cost before something actually asks it for a score."""
    global _model
    if _model is None:
        with _model_lock:
            if _model is None:  # pragma: no branch - re-check under lock
                _model = TextEmbedding(model_name=MODEL_NAME)
    return _model


# Same reasoning as similarity.py's `_tokens_cached`: redundant_peer calls
# score(intent, o.intent) once per peer with the same `intent` every time,
# and embedding inference costs orders of magnitude more than tokenizing, so
# the payoff for hoisting it is bigger here, not smaller. Bounded for the
# same reason - a long-lived relay shouldn't grow this without limit.
@lru_cache(maxsize=2048)
def _embed(text: str) -> tuple[float, ...]:
    vec = next(iter(_get_model().embed([text])))
    return tuple(float(x) for x in vec)


class EmbeddingSimilarity:
    """Cosine similarity over local sentence embeddings.

    Same contract as LexicalSimilarity (see similarity.IntentSimilarity):
    symmetric, empty/whitespace input scores 0.0, never raises. A model load
    or inference failure - no network on first use, a corrupt cache, an
    unsupported platform - is caught and scored 0.0 rather than taking the
    relay down; this sits behind AGENT_SYNC_RUNG4, a path that must fail
    open. See the module docstring for what this backend does and does not
    buy over the lexical one, measured rather than assumed.
    """

    name = "embedding"

    def score(self, a: str, b: str) -> float:
        if not a.strip() or not b.strip():
            return 0.0
        try:
            ea, eb = _embed(a), _embed(b)
        except Exception:
            log.warning("embedding backend failed to score, returning 0.0",
                        exc_info=True)
            return 0.0
        na = math.sqrt(sum(x * x for x in ea))
        nb = math.sqrt(sum(x * x for x in eb))
        if na == 0.0 or nb == 0.0:
            return 0.0
        dot = sum(x * y for x, y in zip(ea, eb))
        return max(0.0, min(1.0, dot / (na * nb)))


register_backend("embedding", EmbeddingSimilarity)
