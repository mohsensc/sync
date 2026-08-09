from __future__ import annotations

import logging

import pytest
from hypothesis import given, settings, strategies as st

from agent_presence.principals import (
    Grant,
    Principal,
    Roster,
    hash_token,
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
