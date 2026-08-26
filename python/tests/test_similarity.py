"""The lexical backend and the seam an embedding backend arrives through."""

import pytest

from agent_presence import similarity
from agent_presence.similarity import (
    BACKEND_ENV,
    IntentSimilarity,
    LexicalSimilarity,
    default_similarity,
    register_backend,
    tokens,
)

sim = LexicalSimilarity()


# -- contract ---------------------------------------------------------------


def test_it_satisfies_the_interface():
    assert isinstance(sim, IntentSimilarity)


@pytest.mark.parametrize("a,b", [
    ("add JWT refresh to auth", "implement token refresh in the login flow"),
    ("fix the CSS grid", "add retry to the S3 uploader"),
    ("add caching to the user endpoint", "add caching to the org endpoint"),
])
def test_score_is_symmetric(a, b):
    assert sim.score(a, b) == sim.score(b, a)


@pytest.mark.parametrize("a,b", [
    ("", ""),
    ("add JWT refresh to auth", ""),
    ("   ", "implement token refresh"),
])
def test_saying_nothing_is_evidence_of_nothing(a, b):
    assert sim.score(a, b) == 0.0


def test_identical_intent_scores_one():
    assert sim.score("add JWT refresh to auth",
                     "add JWT refresh to auth") == pytest.approx(1.0)


def test_score_stays_in_range():
    for a, b in [("add retry with backoff to the uploader",
                  "add retry with backoff to the uploader uploader"),
                 ("auth auth auth token", "token auth")]:
        assert 0.0 <= sim.score(a, b) <= 1.0


# -- the floors -------------------------------------------------------------


def test_one_shared_idea_is_not_enough():
    """Cosine on a two-token intent is all-or-nothing. "fix auth" against
    "auth is broken" would score high on a single shared word, and one word is
    not worth an interrupt."""
    assert sim.score("fix auth", "auth broken") == 0.0


def test_a_shared_verb_alone_is_not_a_match():
    assert sim.score("add a thing", "add another thing") == 0.0


def test_two_shared_structural_nouns_without_a_subject_stay_silent():
    """"endpoint" and "module" are true of half of all work. Matching on those
    alone names no subject, so it is not evidence."""
    assert sim.score("update the endpoint module", "fix the endpoint module") == 0.0


# -- tokenising -------------------------------------------------------------


def test_synonyms_fold_to_one_token():
    assert tokens("JWT")[0] == tokens("bearer token")[0] == "token"
    assert tokens("login") == tokens("signin") == ["auth"]


def test_bigrams_fold_before_unigrams():
    assert tokens("rate limiting") == ["throttle"]
    assert tokens("sign up") == ["auth"]


def test_stopwords_and_filler_verbs_are_dropped():
    assert tokens("use the thing to get at it") == ["thing"]


def test_the_stemmer_leaves_short_words_alone():
    # "user" must not become "us"; "-er" is the greedy suffix and asks for more
    # left over than the others.
    assert "user" in tokens("user")
    assert tokens("scheduled") == tokens("scheduler")


# -- backend selection ------------------------------------------------------


class _Always:
    name = "always"

    def score(self, a, b):
        return 1.0


def test_a_backend_registers_and_is_selected_by_env(monkeypatch):
    register_backend("always", _Always)
    monkeypatch.setenv(BACKEND_ENV, "always")
    assert default_similarity().name == "always"


def test_an_unknown_backend_falls_back_instead_of_raising(monkeypatch):
    monkeypatch.setenv(BACKEND_ENV, "definitely-not-installed")
    assert default_similarity().name == "lexical"


def test_the_default_is_lexical(monkeypatch):
    monkeypatch.delenv(BACKEND_ENV, raising=False)
    assert default_similarity().name == similarity.DEFAULT_BACKEND == "lexical"


def test_selecting_embedding_without_the_extra_falls_back(monkeypatch):
    """Exercises the real ImportError path, not a simulated one: this repo's
    plain dev install does not pull in fastembed (see pyproject.toml), so
    asking for AGENT_PRESENCE_SIMILARITY=embedding here must fall back to
    lexical rather than handing back a backend that can only ever score 0.0.
    Skips itself if the embedding extra happens to be installed - see
    test_embedding_similarity.py for that case."""
    try:
        import fastembed  # noqa: F401
    except ImportError:
        pass
    else:
        pytest.skip("fastembed is installed; see test_embedding_similarity.py")
    monkeypatch.setenv(BACKEND_ENV, "embedding")
    assert default_similarity().name == "lexical"


def test_tune_rung4_tool_still_imports():
    """The tuning tool broke silently for months.

    tune_rung4.py imported DEFAULT_RUNG4_THRESHOLD from ladder.py, which went
    with the Python relay — so it raised ModuleNotFoundError on every run
    while docs/languages.md and STATUS.md both called it live. Nothing
    imported it from a test, so nothing noticed. This is that guard.
    """
    import subprocess
    import sys
    from pathlib import Path

    tool = Path(__file__).resolve().parents[1] / "tools" / "tune_rung4.py"
    assert tool.exists(), "tune_rung4.py is documented as the rung-4 tuning tool"
    out = subprocess.run(
        [sys.executable, str(tool), "--help"],
        capture_output=True, text=True, timeout=60,
    )
    assert out.returncode == 0, f"tune_rung4.py --help failed:\n{out.stderr}"


def test_threshold_matches_the_relay():
    """relaysrv/similarity.go's defaultRung4Threshold is what actually fires.

    The Python constant is only meaningful as the thing the corpus was tuned
    against, so the two disagreeing would make the tuning table describe a
    threshold nobody uses.
    """
    import re
    from pathlib import Path

    from agent_presence.similarity import DEFAULT_RUNG4_THRESHOLD

    go = Path(__file__).resolve().parents[2] / "go" / "internal" / "relaysrv" / "similarity.go"
    m = re.search(r"defaultRung4Threshold\s*=\s*([0-9.]+)", go.read_text())
    assert m, "could not find defaultRung4Threshold in similarity.go"
    assert float(m.group(1)) == DEFAULT_RUNG4_THRESHOLD
