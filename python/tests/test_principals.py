from __future__ import annotations

import logging

import pytest
from hypothesis import given, settings, strategies as st

from agent_presence.principals import (
    Grant,
    Principal,
    Roster,
    hash_token,
    local_identity,
    mint_token,
    read_token,
    token_path,
)
from agent_presence.priority import (
    PRIORITY_MAX,
    PRIORITY_MIN,
    PRIORITY_NAMES,
    PRIORITY_NORMAL,
)

TOKEN = "s3cr3t-token-value"
OTHER = "not-the-right-token"


def roster_text(**overrides) -> str:
    body = {
        "version": 1,
        "default_tier": "normal",
    }
    body.update(overrides)
    lines = [f"{k} = {v!r}" if isinstance(v, str) else f"{k} = {v}"
             for k, v in body.items()]
    return "\n".join(lines) + f"""

[[principal]]
id           = "sara"
display      = "Sara"
attended     = "normal"
unattended   = "elevated"
token_sha256 = "{hash_token(TOKEN)}"

[[principal]]
id           = "release-bot"
attended     = "critical"
unattended   = "critical"
token_sha256 = "{hash_token('bot-token')}"
"""


@pytest.fixture
def roster() -> Roster:
    return Roster.parse(roster_text(), source="<test>")


# -- tokens ------------------------------------------------------------------


def test_a_minted_token_hashes_into_the_roster_and_authenticates(roster):
    token = mint_token()
    entry = Principal("ops", "Ops", 1, 3, hash_token(token))
    live = Roster((entry,), source="<test>", present=True)
    assert live.authenticate("ops", token).principal == "ops"


def test_minted_tokens_are_not_guessable_and_not_repeated():
    tokens = {mint_token() for _ in range(200)}
    assert len(tokens) == 200
    assert all(len(t) >= 40 for t in tokens)


def test_the_roster_holds_only_the_hash(roster):
    text = roster_text()
    assert TOKEN not in text
    assert hash_token(TOKEN) in text


# -- the §4.4 failure table, row by row --------------------------------------


def test_no_roster_file_leaves_everyone_normal(tmp_path):
    absent = Roster.load(tmp_path / "nope.toml")
    assert not absent.present
    grant = absent.authenticate("sara", TOKEN)
    assert grant.reason == "no-roster"
    assert grant.priority(unattended=True) == PRIORITY_NORMAL


def test_a_join_with_no_principal_gets_the_default_tier(roster):
    grant = roster.authenticate(None, None)
    assert grant.reason == "no-token"
    assert grant.priority(unattended=True) == roster.default_tier
    assert not grant.authenticated


def test_an_unknown_principal_gets_the_default_tier(roster, caplog):
    with caplog.at_level(logging.INFO):
        grant = roster.authenticate("nobody", TOKEN)
    assert grant.reason == "unknown"
    assert grant.priority(unattended=True) == roster.default_tier
    assert "nobody" in caplog.text


def test_a_missing_token_is_a_warning_not_a_refusal(roster, caplog):
    with caplog.at_level(logging.WARNING):
        grant = roster.authenticate("sara", None, room="r1")
    assert grant.reason == "no-token"
    assert grant.priority(unattended=True) == roster.default_tier
    assert "sara" in caplog.text and "r1" in caplog.text


def test_a_wrong_token_is_a_warning_not_a_refusal(roster, caplog):
    # A bad token is never a join refusal. Refusing would make the relay a hard
    # dependency and break the fail-open principle the C++ side is built on end
    # to end. Losing a rung is the right punishment.
    with caplog.at_level(logging.WARNING):
        grant = roster.authenticate("release-bot", OTHER, room="r1")
    assert grant.reason == "bad-token"
    assert grant.priority(unattended=True) == roster.default_tier
    assert "release-bot" in caplog.text and "r1" in caplog.text
    assert OTHER not in caplog.text, "the presented token was logged"


def test_an_unparseable_roster_is_inert_and_loud(caplog):
    with caplog.at_level(logging.ERROR):
        broken = Roster.parse("this is not [ toml", source="<test>")
    assert broken.degraded
    assert broken.principals() == []
    assert broken.authenticate("sara", TOKEN).priority(unattended=True) == (
        PRIORITY_NORMAL
    )
    assert "unparseable" in caplog.text.lower() or "toml" in caplog.text.lower()


def test_a_torn_append_demotes_everyone_not_just_the_new_row(caplog):
    """This is the failure `ap principals add` used to risk: a crash or
    ENOSPC partway through an `open(path, "a")` append leaves the file
    cut off mid block, not just missing the new principal. Roster.parse
    can't tell "torn" from "garbage" -- any decode error is inert, so the
    existing critical-priority principal is gone too, silently, with one
    log line. That's the bug atomic_write in cli.py now closes."""
    whole = f"""
version = 1
default_tier = "normal"

[[principal]]
id           = "release-bot"
attended     = "critical"
unattended   = "critical"
token_sha256 = "{hash_token('bot-token')}"
"""
    # A write interrupted mid-append: the new block starts but never
    # finishes -- no closing quote, no value at all for the last key.
    torn = whole + '\n[[principal]]\nid           = "sara"\ndisplay      = "S'

    with caplog.at_level(logging.ERROR):
        parsed = Roster.parse(torn, source="<test>")

    assert parsed.degraded
    assert parsed.principals() == []
    # release-bot was fully written and valid on its own, but the torn
    # file is unparseable as a whole, so it is gone too.
    assert parsed.authenticate("release-bot", "bot-token").priority(
        unattended=True
    ) == PRIORITY_NORMAL
    assert "unparseable" in caplog.text.lower() or "toml" in caplog.text.lower()


def test_an_inverted_band_drops_that_principal_to_the_default(caplog):
    text = f"""
version = 1
default_tier = "normal"

[[principal]]
id = "backwards"
attended = "critical"
unattended = "background"
token_sha256 = "{hash_token(TOKEN)}"

[[principal]]
id = "fine"
attended = "normal"
unattended = "elevated"
token_sha256 = "{hash_token(TOKEN)}"
"""
    with caplog.at_level(logging.WARNING):
        parsed = Roster.parse(text, source="<test>")
    grant = parsed.authenticate("backwards", TOKEN)
    assert grant.priority(unattended=True) == parsed.default_tier
    assert grant.priority(unattended=False) == parsed.default_tier
    assert "backwards" in caplog.text
    # The rest of the roster still works: one bad row is not a dead roster.
    assert parsed.authenticate("fine", TOKEN).priority(unattended=True) == 2


@pytest.mark.parametrize(
    "entry,why",
    [
        ('id = "x"', "no token_sha256"),
        ('token_sha256 = "abc"', "no id, short hash"),
        ('id = "x"\ntoken_sha256 = "nothex"', "hash is not 64 hex"),
        ('id = ""\ntoken_sha256 = "' + "a" * 64 + '"', "empty id"),
    ],
)
def test_a_malformed_principal_is_dropped_not_fatal(entry, why, caplog):
    text = f"version = 1\n\n[[principal]]\n{entry}\n"
    with caplog.at_level(logging.WARNING):
        parsed = Roster.parse(text, source="<test>")
    assert parsed.principals() == [], why
    assert parsed.degraded
    assert parsed.authenticate("x", TOKEN).priority(unattended=True) == (
        PRIORITY_NORMAL
    )


def test_a_bad_default_tier_falls_back_to_normal(caplog):
    with caplog.at_level(logging.WARNING):
        parsed = Roster.parse('version = 1\ndefault_tier = "urgent"\n')
    assert parsed.default_tier == PRIORITY_NORMAL
    assert parsed.degraded


def test_a_bad_tier_on_a_principal_falls_back_to_the_default(caplog):
    text = f"""
version = 1
default_tier = "background"

[[principal]]
id = "x"
attended = "supreme"
unattended = "critical"
token_sha256 = "{hash_token(TOKEN)}"
"""
    with caplog.at_level(logging.WARNING):
        parsed = Roster.parse(text)
    grant = parsed.authenticate("x", TOKEN)
    assert grant.attended == PRIORITY_NAMES["background"]
    assert grant.unattended == PRIORITY_NAMES["critical"]
    assert parsed.degraded


def test_a_duplicate_id_keeps_the_first_and_says_so(caplog):
    text = f"""
version = 1

[[principal]]
id = "x"
attended = "background"
unattended = "background"
token_sha256 = "{hash_token(TOKEN)}"

[[principal]]
id = "x"
attended = "critical"
unattended = "critical"
token_sha256 = "{hash_token(OTHER)}"
"""
    with caplog.at_level(logging.WARNING):
        parsed = Roster.parse(text)
    assert len(parsed.principals()) == 1
    assert parsed.authenticate("x", TOKEN).priority(unattended=True) == 0
    assert "duplicate" in caplog.text


def test_a_future_version_is_read_anyway_rather_than_dropped(caplog):
    # Refusing the file would drop protection, which is the one thing a bad
    # config must never be able to do.
    text = roster_text(version=99)
    with caplog.at_level(logging.WARNING):
        parsed = Roster.parse(text)
    assert parsed.degraded
    assert parsed.authenticate("sara", TOKEN).principal == "sara"


# -- the band rule -----------------------------------------------------------


def test_the_unattended_flag_selects_inside_the_band(roster):
    grant = roster.authenticate("sara", TOKEN)
    assert grant.priority(unattended=False) == PRIORITY_NAMES["normal"]
    assert grant.priority(unattended=True) == PRIORITY_NAMES["elevated"]


def test_a_flat_band_ignores_the_flag(roster):
    grant = roster.authenticate("release-bot", "bot-token")
    assert grant.priority(unattended=False) == PRIORITY_NAMES["critical"]
    assert grant.priority(unattended=True) == PRIORITY_NAMES["critical"]


bands = st.tuples(
    st.integers(PRIORITY_MIN, PRIORITY_MAX), st.integers(PRIORITY_MIN, PRIORITY_MAX)
)


@given(bands, st.booleans())
def test_a_granted_tier_is_always_inside_its_band(band, unattended):
    # The rule the whole surface rests on: client-supplied fields may only
    # select within a verified band, and verified data sets the ceiling.
    grant = Grant(
        principal="p", attended=band[0], unattended=band[1], reason="roster"
    )
    low, high = min(band), max(band)
    assert low <= grant.priority(unattended=unattended) <= high


@settings(max_examples=100)
@given(
    st.lists(
        st.tuples(
            st.text(alphabet="abcdef", min_size=1, max_size=4),
            st.integers(PRIORITY_MIN, PRIORITY_MAX),
            st.integers(PRIORITY_MIN, PRIORITY_MAX),
        ),
        min_size=1,
        max_size=5,
    ),
    st.booleans(),
)
def test_no_generated_roster_grants_above_its_own_ceiling(entries, unattended):
    lines = ["version = 1", 'default_tier = "background"']
    bands_by_id: dict[str, tuple[int, int]] = {}
    for ident, attended, unatt in entries:
        if ident in bands_by_id:
            continue
        bands_by_id[ident] = (attended, unatt)
        lines.append(
            f'\n[[principal]]\nid = "{ident}"\nattended = {attended}\n'
            f'unattended = {unatt}\ntoken_sha256 = "{hash_token(ident)}"'
        )
    parsed = Roster.parse("\n".join(lines))

    for ident, (attended, unatt) in bands_by_id.items():
        grant = parsed.authenticate(ident, ident)
        ceiling = max(attended, unatt) if attended <= unatt else parsed.default_tier
        assert grant.priority(unattended=unattended) <= ceiling


# -- a client cannot raise itself --------------------------------------------


def test_a_principal_with_no_token_cannot_reach_its_own_tier(roster):
    # The only threat model that matters: an agent reads the roster out of the
    # repo, notices release-bot is critical, and names itself release-bot.
    grant = roster.authenticate("release-bot", None)
    assert grant.priority(unattended=True) == roster.default_tier
    assert grant.priority(unattended=True) < PRIORITY_NAMES["critical"]


def test_a_stolen_name_with_a_guessed_token_gets_nothing_extra(roster):
    for guess in ("", "bot", "critical", TOKEN, hash_token("bot-token")):
        grant = roster.authenticate("release-bot", guess)
        assert grant.priority(unattended=True) == roster.default_tier


def test_the_hash_in_the_roster_is_not_itself_a_usable_token(roster):
    # Presenting the stored hash must not authenticate — otherwise the roster,
    # which is committed, is the credential.
    assert roster.authenticate("sara", hash_token(TOKEN)).reason == "bad-token"


def test_claiming_unattended_only_reaches_the_top_of_your_own_band(roster):
    # A lying client can impersonate itself at its own ceiling. That is a
    # mislabelling, not an escalation, and it costs nobody but the liar.
    sara = roster.authenticate("sara", TOKEN)
    bot = roster.authenticate("release-bot", "bot-token")
    assert sara.priority(unattended=True) < bot.priority(unattended=False)


def test_discover_prefers_the_env_override(tmp_path, monkeypatch):
    path = tmp_path / "principals.toml"
    path.write_text(roster_text())
    monkeypatch.setenv("AGENT_PRESENCE_PRINCIPALS", str(path))
    assert Roster.discover().authenticate("sara", TOKEN).principal == "sara"


def test_discover_falls_back_to_the_repo_root(tmp_path, monkeypatch):
    monkeypatch.delenv("AGENT_PRESENCE_PRINCIPALS", raising=False)
    target = tmp_path / ".agent-presence" / "principals.toml"
    target.parent.mkdir(parents=True)
    target.write_text(roster_text())
    assert Roster.discover(str(tmp_path)).authenticate("sara", TOKEN).principal == (
        "sara"
    )


def test_discover_on_a_repo_with_no_roster_is_inert(tmp_path, monkeypatch):
    monkeypatch.delenv("AGENT_PRESENCE_PRINCIPALS", raising=False)
    found = Roster.discover(str(tmp_path))
    assert not found.present
    assert not found.degraded


# -- where this machine keeps its own token ----------------------------------


def test_the_token_path_follows_the_same_rule_as_the_user_policy(tmp_path):
    xdg = tmp_path / "xdg"
    home = tmp_path / "home"
    assert token_path({"XDG_CONFIG_HOME": str(xdg)}) == \
        xdg / "agent-presence" / "token"
    assert token_path({"HOME": str(home)}) == \
        home / ".config" / "agent-presence" / "token"


def test_the_environment_token_wins_over_the_file(tmp_path):
    xdg = tmp_path / "xdg"
    (xdg / "agent-presence").mkdir(parents=True)
    (xdg / "agent-presence" / "token").write_text("from-the-file\n")
    env = {"XDG_CONFIG_HOME": str(xdg), "AGENT_PRESENCE_TOKEN": "from-the-env"}
    assert read_token(env) == "from-the-env"


def test_the_token_file_is_read_and_trimmed(tmp_path):
    xdg = tmp_path / "xdg"
    (xdg / "agent-presence").mkdir(parents=True)
    (xdg / "agent-presence" / "token").write_text("  the-token  \n# a note\n")
    assert read_token({"XDG_CONFIG_HOME": str(xdg)}) == "the-token"


def test_no_token_anywhere_is_empty_rather_than_an_error(tmp_path):
    assert read_token({"XDG_CONFIG_HOME": str(tmp_path / "nope")}) == ""
    assert read_token({}) == ""


# -- configure once, and it holds --------------------------------------------
#
# The user this is aimed at writes one roster entry and expects it to be true
# everywhere. Two places it was not.


def test_naming_one_end_of_the_band_sets_both():
    # `attended = "critical"` and nothing else used to mean attended critical
    # and unattended normal — an inverted band, which the guard below then
    # flattened to normal at BOTH ends. So the single most likely hand-written
    # roster entry granted exactly nothing, and said so only in one warning line
    # in the relay's startup log.
    roster = Roster.parse(f"""
[[principal]]
id = "sara"
attended = "critical"
token_sha256 = "{hash_token('t')}"
""")
    entry = roster.principals()[0]
    assert (entry.attended, entry.unattended) == (
        PRIORITY_NAMES["critical"], PRIORITY_NAMES["critical"]
    )
    assert roster.problems == ()


def test_naming_only_the_unattended_end_mirrors_the_other_way():
    roster = Roster.parse(f"""
[[principal]]
id = "sara"
unattended = "elevated"
token_sha256 = "{hash_token('t')}"
""")
    entry = roster.principals()[0]
    assert (entry.attended, entry.unattended) == (
        PRIORITY_NAMES["elevated"], PRIORITY_NAMES["elevated"]
    )
    assert roster.problems == ()


def test_a_band_still_opens_when_two_different_tiers_are_written():
    roster = Roster.parse(f"""
[[principal]]
id = "sara"
attended = "normal"
unattended = "critical"
token_sha256 = "{hash_token('t')}"
""")
    entry = roster.principals()[0]
    assert entry.attended == PRIORITY_NAMES["normal"]
    assert entry.unattended == PRIORITY_NAMES["critical"]


def test_an_inverted_band_is_still_refused():
    # The mirroring must not paper over a genuinely inverted band: that would
    # let the client's one bit lower its tier as well as raise it.
    roster = Roster.parse(f"""
[[principal]]
id = "sara"
attended = "critical"
unattended = "normal"
token_sha256 = "{hash_token('t')}"
""")
    entry = roster.principals()[0]
    assert entry.attended == entry.unattended == PRIORITY_NORMAL
    assert any("above unattended" in p for p in roster.problems)


def test_a_principal_who_writes_nothing_still_lands_on_default_tier():
    roster = Roster.parse(f"""
default_tier = "elevated"

[[principal]]
id = "sara"
token_sha256 = "{hash_token('t')}"
""")
    entry = roster.principals()[0]
    assert entry.attended == entry.unattended == PRIORITY_NAMES["elevated"]


def test_a_bad_tier_on_one_end_does_not_poison_the_other():
    roster = Roster.parse(f"""
[[principal]]
id = "sara"
attended = "urgent"
unattended = "critical"
token_sha256 = "{hash_token('t')}"
""")
    entry = roster.principals()[0]
    # attended fell back to the default and the band inverted the safe way
    # round, so nothing is granted above what was actually written down.
    assert entry.attended == PRIORITY_NORMAL
    assert any("urgent" in p for p in roster.problems)


def test_local_identity_reads_the_same_three_env_vars_the_daemon_does():
    env = {
        "AGENT_PRESENCE_PRINCIPAL": " sara ",
        "AGENT_PRESENCE_TOKEN": " s3cret ",
        "AGENT_PRESENCE_UNATTENDED": "yes",
    }
    who = local_identity(env)
    assert (who.principal, who.token, who.unattended) == ("sara", "s3cret", True)


def test_local_identity_on_a_machine_that_configured_nothing():
    who = local_identity({"HOME": "/nonexistent"})
    assert who.principal is None
    assert who.token == ""
    assert who.unattended is False


# -- finding the roster at all -----------------------------------------------
#
# It used to look in one directory: the one the process happened to start in.
# A relay started in `repo/server/`, or by a service manager with no working
# directory worth the name, read no roster and granted every connection
# `normal` — the roster that decides who outranks whom, skipped, in silence.


def write_roster(root, text: str = None):
    target = root / ".agent-presence" / "principals.toml"
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(roster_text() if text is None else text)
    return target


def test_the_roster_is_found_from_a_subdirectory_of_the_checkout(tmp_path):
    (tmp_path / ".git").mkdir()
    write_roster(tmp_path)
    deep = tmp_path / "services" / "relay"
    deep.mkdir(parents=True)
    found = Roster.discover(str(deep), env={})
    assert found.authenticate("sara", TOKEN).principal == "sara"


def test_the_walk_stops_at_the_checkout(tmp_path):
    # A roster above the repo is somebody else's, or nobody's. Picking it up
    # would set tiers for every repo under that directory by accident, and the
    # file that decides who outranks whom is not one to find by accident.
    write_roster(tmp_path)
    repo = tmp_path / "repo"
    (repo / ".git").mkdir(parents=True)
    assert not Roster.discover(str(repo), env={}).present


def test_the_env_override_still_wins_over_the_walk(tmp_path):
    write_roster(tmp_path, roster_text())
    (tmp_path / ".git").mkdir()
    elsewhere = tmp_path / "explicit.toml"
    elsewhere.write_text(roster_text().replace("sara", "morgan"))
    found = Roster.discover(
        str(tmp_path), env={"AGENT_PRESENCE_PRINCIPALS": str(elsewhere)}
    )
    assert found.authenticate("morgan", TOKEN).principal == "morgan"



# A relay saying which roster it's enforcing (or that it found none) used to
# be pinned here against the Python Relay's logger. It's `NewRelay`'s job in
# Go now (#40) — `relaysrv.NewRelay` logs the same two shapes
# ("roster %s: %d principal(s)..." / "no principals roster...") off the same
# `Roster.discover`-equivalent this file already covers on its own.
