"""The embedding backend and the seam it registers through.

Skipped unless the 'embedding' extra is installed
(`pip install -e '.[dev,embedding]'`) - see embedding_similarity.py's
docstring for why that extra isn't part of the default dev install, and
test_similarity.py's `test_selecting_embedding_without_the_extra_falls_back`
for the coverage on the other side of that line.
"""

import pytest

pytest.importorskip("fastembed", reason="pip install -e '.[dev,embedding]'")

from agent_sync import embedding_similarity
from agent_sync.embedding_similarity import EmbeddingSimilarity
from agent_sync.similarity import (
    BACKEND_ENV,
    IntentSimilarity,
    LexicalSimilarity,
    default_similarity,
)

sim = EmbeddingSimilarity()


# -- contract, same shape as LexicalSimilarity's -----------------------------


def test_it_satisfies_the_interface():
    assert isinstance(sim, IntentSimilarity)


def test_it_is_selected_through_the_seam(monkeypatch):
    monkeypatch.setenv(BACKEND_ENV, "embedding")
    assert default_similarity().name == "embedding"


@pytest.mark.parametrize("a,b", [
    ("add JWT refresh to auth", "implement token refresh in the login flow"),
    ("fix the CSS grid on the settings page", "add retry to the S3 uploader"),
])
def test_score_is_symmetric(a, b):
    assert sim.score(a, b) == pytest.approx(sim.score(b, a))


@pytest.mark.parametrize("a,b", [
    ("", ""),
    ("add JWT refresh to auth", ""),
    ("   ", "implement token refresh"),
])
def test_saying_nothing_is_evidence_of_nothing(a, b):
    assert sim.score(a, b) == 0.0


def test_identical_intent_scores_one():
    assert sim.score("add JWT refresh to auth",
                     "add JWT refresh to auth") == pytest.approx(1.0, abs=1e-4)


def test_score_stays_in_range():
    for a, b in [
        ("add retry with backoff to the uploader", "fix the css grid"),
        ("auth auth auth token", "token auth"),
    ]:
        assert 0.0 <= sim.score(a, b) <= 1.0


def test_it_scores_the_paraphrase_lexical_cannot_see_at_all():
    """embedding_similarity.py's docstring names this as the one thing a
    synonym table structurally can't do. This doesn't assert a threshold -
    see that docstring for why 'beats lexical on this corpus' is not the
    claim being made - only that the score moves at all, which is the
    minimum bar for the paraphrase case to be worth having in the codebase."""
    a, b = "harden the upload path", "add checksum verification to uploads"
    assert LexicalSimilarity().score(a, b) == 0.0
    assert sim.score(a, b) > 0.0


def test_a_scoring_failure_returns_zero_instead_of_raising(monkeypatch):
    def boom(text):
        raise RuntimeError("no model for you")

    monkeypatch.setattr(embedding_similarity, "_embed", boom)
    assert sim.score("add JWT refresh to auth", "fix the css grid") == 0.0
