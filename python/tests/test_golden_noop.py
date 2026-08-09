"""Installing the policy engine and configuring nothing changes nothing.

This is the test that matters most. Every other test here says "policy does the
right thing when you ask it to"; this one says "policy does nothing at all when
you don't", which is the promise that makes the rest safe to ship.

`tests/helpers/golden_base.json` was produced by running
`tests/helpers/golden_scenario.py` on `fix/lease-protection`, before any of this
existed. It is a recording, not an expectation somebody typed out, so it cannot
drift into agreeing with the code by accident. Regenerate it only by checking
out that branch and running the script again.

Four keys are allowed to be new, and no others:

    effect            how loudly this rung is told
    effect_source     which layer said so
    priority          the requester's tier, by name
    holder_priority   the holder's tier, by name

With no policy.toml and no principals.toml on the search path all four sit at
their defaults — `silent`/`context`/`deny` straight off BUILTIN, `builtin` as
the source, `normal` at both ends of every contest.
"""

from __future__ import annotations

import json
import pathlib
import sys

import pytest

HELPERS = pathlib.Path(__file__).parent / "helpers"
sys.path.insert(0, str(HELPERS))

from golden_scenario import run  # noqa: E402

ALLOWED_ADDITIONS = frozenset(
    {"effect", "effect_source", "priority", "holder_priority"}
)


@pytest.fixture(autouse=True)
def no_configuration(monkeypatch, tmp_path):
    """A machine with nothing configured, whatever the machine running this has.

    Pointing every discovery path at an empty directory rather than unsetting
    the env vars: the defaults are absolute paths (/etc/agent-presence, ~/.config)
    and a developer who has genuinely configured one of them should not get a
    green run that means nothing.
    """
    empty = tmp_path / "empty"
    empty.mkdir()
    monkeypatch.setenv("AGENT_PRESENCE_ORG_POLICY", str(empty / "org.toml"))
    monkeypatch.setenv("AGENT_PRESENCE_PRINCIPALS", str(empty / "principals.toml"))
    monkeypatch.setenv("AGENT_PRESENCE_REPO_ROOT", str(empty))
    monkeypatch.setenv("XDG_CONFIG_HOME", str(empty))
    monkeypatch.delenv("AGENT_PRESENCE_POLICY", raising=False)
    for rung in range(5):
        monkeypatch.delenv(f"AGENT_PRESENCE_POLICY_RUNG{rung}", raising=False)


def _baseline() -> dict:
    return json.loads((HELPERS / "golden_base.json").read_text())


def _compare(old, new, where: str) -> set[str]:
    """Walk both sides together. Returns every key that is new."""
    added: set[str] = set()
    assert type(old) is type(new), f"{where}: {type(old)} became {type(new)}"

    if isinstance(old, list):
        assert len(old) == len(new), (
            f"{where}: {len(old)} frames became {len(new)}"
        )
        for index, (a, b) in enumerate(zip(old, new)):
            added |= _compare(a, b, f"{where}[{index}]")
        return added

    if isinstance(old, dict):
        gone = set(old) - set(new)
        assert not gone, f"{where}: fields disappeared: {sorted(gone)}"
        new_keys = set(new) - set(old)
        assert new_keys <= ALLOWED_ADDITIONS, (
            f"{where}: undocumented new fields {sorted(new_keys - ALLOWED_ADDITIONS)}"
        )
        added |= new_keys
        for key in old:
            added |= _compare(old[key], new[key], f"{where}.{key}")
        return added

    assert old == new, f"{where}: {old!r} became {new!r}"
    return added


def test_every_relay_visible_frame_is_what_it_was_before_policy_existed():
    added = set()
    baseline, current = _baseline(), run()
    assert set(baseline) == set(current)
    for section in baseline:
        added |= _compare(baseline[section], current[section], section)
    # Not just "nothing broke": the additions have to have actually landed, or
    # this test would pass just as happily against a policy engine that was
    # never wired in at all.
    assert added == ALLOWED_ADDITIONS


def test_the_added_fields_all_sit_at_their_documented_defaults():
    frames = [f for section in run().values() for f in section]

    effects = {f["effect"] for f in frames if "effect" in f}
    assert effects <= {"silent", "context", "deny"}, (
        f"an unconfigured room produced {sorted(effects)}"
    )
    assert {f["effect_source"] for f in frames if "effect_source" in f} == {"builtin"}
    tiers = {f[k] for f in frames for k in ("priority", "holder_priority") if k in f}
    assert tiers == {"normal"}


def test_rungs_0_to_2_never_reach_ask_or_deny_with_nothing_configured():
    # Requirement 5, on the wire rather than in the resolver. `ask` and `deny`
    # are the only two effects that set permissionDecision, and neither is a
    # shipped default below rung 3.
    for frame in [f for section in run().values() for f in section]:
        if frame.get("rung") is not None and frame["rung"] <= 2:
            assert frame.get("effect") in (None, "silent", "notify", "context"), (
                f"rung {frame['rung']} interrupted with {frame.get('effect')!r}"
            )


def test_nothing_is_ever_negotiated_below_rung_3_by_default():
    frames = [f for section in run().values() for f in section]
    negotiated = [f for f in frames if f.get("type") == "negotiate"]
    assert negotiated, "the scenario stopped exercising the rung 3 path"
    assert all(f["rung"] >= 3 for f in negotiated)
