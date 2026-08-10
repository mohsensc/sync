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
