"""Score the rung 4 tuning corpus and print the table the threshold came from.

    ./.venv/bin/python tools/tune_rung4.py

Read the argument, not just the number. The corpus is three groups:

  DUPLICATE  two agents doing the same work. Should fire.
  UNRELATED  two agents doing different work. Must stay silent.
  NEAR_MISS  the ones that decide the threshold. Structurally identical
             intents where a single noun differs, which is precisely where a
             lexical scorer has the least idea what it is looking at. Every
             one of these must stay BELOW the threshold, and they are the
             reason the threshold is not 0.7.

False positives are the risk here, not false negatives. A missed duplicate
costs one agent some wasted work, which is exactly the status quo without this
feature. A false interrupt costs trust in rungs 0-3, which are the part that
works. So the threshold sits above the worst near miss with room to spare, and
the honest consequence is that the weaker duplicates below it are missed.
"""

from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from agent_presence.ladder import DEFAULT_RUNG4_THRESHOLD  # noqa: E402
from agent_presence.similarity import LexicalSimilarity  # noqa: E402

DUPLICATE: list[tuple[str, str]] = [
    ("add JWT refresh to auth",
     "implement token refresh in the login flow"),
    ("refactor session handling to use JWT",
     "move the login session over to bearer tokens"),
    ("add pagination to the users list endpoint",
     "implement paging on the user list API"),
    ("add retry with backoff to the S3 uploader",
     "make the S3 upload retry with backoff on failure"),
    ("cache the org settings lookup",
     "add caching for org settings queries"),
    ("rate limit the signup endpoint",
     "add throttling to the sign up route"),
    ("validate the webhook signature",
     "add signature validation to incoming webhooks"),
    ("fix the timezone conversion in the scheduler",
     "correct timezone handling for scheduled jobs"),
]

UNRELATED: list[tuple[str, str]] = [
    ("fix the CSS grid on the settings page",
     "add retry to the S3 uploader"),
    ("update the README install steps",
     "add a database index on the orders created_at column"),
    ("bump the eslint config to flat config",
     "handle timezone conversion in the scheduler"),
    ("add JWT refresh to auth",
     "fix the spacing on the pricing page"),
    ("write tests for the payment webhook",
     "rename the deploy script"),
    ("add pagination to the users list",
     "investigate the slow websocket reconnect"),
]

NEAR_MISS: list[tuple[str, str]] = [
    # Same shape, different subject. This is the whole problem: a lexical
    # scorer sees four of five tokens agree and has no idea the one that
    # differs is the only one that mattered.
    ("migrate the users table to the new schema",
     "migrate the orders table to the new schema"),
    ("add retry with backoff to the S3 uploader",
     "add retry with backoff to the GCS uploader"),
    ("write unit tests for the auth module",
     "write unit tests for the billing module"),
    ("add caching to the user profile endpoint",
     "add caching to the org settings endpoint"),
    ("add rate limiting to the login endpoint",
     "add logging to the login endpoint"),
    ("fix the payment webhook signature check",
     "write tests for the payment webhook"),
    ("add an index on orders.created_at",
     "add an index on users.created_at"),
    ("refactor the upload service to use streams",
     "refactor the download service to use streams"),
    # Two people on the same feature from opposite ends. Related work, but not
    # redundant work - interrupting here would be wrong.
    ("add the billing settings UI",
     "add the billing settings API endpoint"),
]


def main() -> int:
    sim = LexicalSimilarity()
    threshold = DEFAULT_RUNG4_THRESHOLD

    groups = [
        ("DUPLICATE  (want >= threshold)", DUPLICATE, True),
        ("NEAR MISS  (want <  threshold)", NEAR_MISS, False),
        ("UNRELATED  (want ~0)", UNRELATED, False),
    ]

    print(f"backend: {sim.name}   threshold: {threshold:.2f}\n")
    worst_dup = 1.0
    best_bad = 0.0
    misses = 0

    for title, pairs, want_fire in groups:
        print(title)
        print("-" * 96)
        for a, b in pairs:
            s = sim.score(a, b)
            fires = s >= threshold
            ok = fires == want_fire
            if want_fire:
                worst_dup = min(worst_dup, s)
            else:
                best_bad = max(best_bad, s)
            if not ok:
                misses += 1
            mark = "  " if ok else ("FP" if fires else "fn")
            print(f"  {s:5.3f} {mark}  {a}")
            print(f"              {b}")
        print()

    bad = NEAR_MISS + UNRELATED
    print("threshold sweep")
    print("-" * 96)
    print("  thresh   fires   missed   FALSE POSITIVES")
    for t in (0.60, 0.70, 0.75, 0.80, 0.82, 0.85, 0.90):
        fp = sum(1 for a, b in bad if sim.score(a, b) >= t)
        fn = sum(1 for a, b in DUPLICATE if sim.score(a, b) < t)
        here = " <- default" if abs(t - threshold) < 1e-9 else ""
        print(f"   {t:.2f}    {len(DUPLICATE) - fn:>2}/{len(DUPLICATE)}"
              f"     {fn:>2}       {fp:>2}/{len(bad)}{here}")
    print()

    print("-" * 96)
    print(f"weakest firing duplicate: {min((s for s in (sim.score(a, b) for a, b in DUPLICATE) if s >= threshold), default=0.0):.3f}")
    print(f"highest non-duplicate:    {best_bad:.3f}")
    print(f"usable band:              ({best_bad:.3f}, "
          f"{min((s for s in (sim.score(a, b) for a, b in DUPLICATE) if s >= threshold), default=1.0):.3f}]")
    print(f"false positives at {threshold:.2f}:    "
          f"{sum(1 for a, b in bad if sim.score(a, b) >= threshold)}")
    print(f"missed duplicates:        {sum(1 for a, b in DUPLICATE if sim.score(a, b) < threshold)}")

    # The only failure that matters here. Missed duplicates are a cost we chose;
    # a false positive at the shipped threshold is a regression.
    return 1 if any(sim.score(a, b) >= threshold for a, b in bad) else 0


if __name__ == "__main__":
    raise SystemExit(main())
