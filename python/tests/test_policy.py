from __future__ import annotations

import json
import logging
import pathlib

import pytest
from hypothesis import given, settings, strategies as st

from agent_presence.clock import VirtualClock
from agent_presence.policy import (
    BUILTIN,
    BUILTIN_FLOOR,
    EFFECTS,
    RANK,
    RUNGS,
    EffectTable,
    Policy,
    PolicyFile,
    build_policy,
    builtin_layer,
    compile_runtime,
    discover,
    parse_layer,
    runtime_cache_path,
    write_runtime_cache,
)

ANY = "src/app.py"


def layers(*specs) -> Policy:
    """A policy from (name, toml) pairs, builtin always at the bottom."""
    built = [builtin_layer()]
    for name, text in specs:
        built.append(parse_layer(text, name=name, source=f"<{name}>"))
    return build_policy(built)


# -- defaults ----------------------------------------------------------------


def test_an_empty_stack_resolves_to_builtin_on_every_rung():
    policy = build_policy([builtin_layer()])
    for rung in RUNGS:
        assert policy.resolve(rung, ANY).effect == BUILTIN[rung]
    assert not policy.degraded
    assert policy.problems == ()


def test_the_shipped_defaults_are_the_documented_ones():
    assert BUILTIN.names() == ["silent", "notify", "context", "deny", "silent"]
    assert BUILTIN_FLOOR.names() == [
        "silent", "silent", "silent", "notify", "silent"
    ]


def test_an_empty_config_file_changes_nothing():
    policy = layers(("user", ""))
    for rung in RUNGS:
        assert policy.resolve(rung, ANY).effect == BUILTIN[rung]
    assert not policy.degraded


def test_rung_4_is_silent_by_default_which_is_the_off_switch():
    # A silent rung 4 also short-circuits the similarity computation. One
    # concept, not a flag plus an effect. Rung 4 is unimplemented, so this
    # ships as "still off".
    assert BUILTIN[4] == "silent"
    assert build_policy([builtin_layer()]).resolve(4, ANY).effect == "silent"


# -- every documented bad input ----------------------------------------------


BAD_INPUTS = [
    ('[effects]\nrung3 = "explode"\n', "unknown effect"),
    ('[effects]\nrung9 = "deny"\n', "unknown rung key"),
    ('[effects]\nnonsense = "deny"\n', "unknown key entirely"),
    ("[effects]\nrung3 = 7\n", "wrong type"),
    ("[effects]\nrung3 = true\n", "boolean where an effect goes"),
    ('schema = 99\n[effects]\nrung3 = "ask"\n', "wrong schema version"),
    ('effects = "not a table"\n', "[effects] is not a table"),
    ('mode = "sideways"\n', "unknown mode"),
    ('[[path]]\nmatch = "src/[unclosed"\nrung3 = "ask"\n', "invalid glob"),
    ('[[path]]\nrung3 = "ask"\n', "path rule with no match"),
    ('path = "not an array"\n', "[[path]] is not an array of tables"),
    ("path = [1]\n", "a path entry that is not a table"),
    ('[floor]\nrung3 = "wat"\n', "unknown effect in a floor"),
    ('floor = "not a table"\n', "[floor] is not a table"),
]


@pytest.mark.parametrize("text,why", BAD_INPUTS)
def test_bad_input_never_raises_and_records_exactly_one_problem(text, why):
    layer = parse_layer(text, name="repo", source="<bad>")
    assert len(layer.problems) == 1, (
        f"{why}: expected one problem line, got {layer.problems}"
    )
    assert "<bad>" in layer.problems[0]


@pytest.mark.parametrize("text,why", BAD_INPUTS)
def test_bad_input_never_resolves_below_the_builtin_floor(text, why):
    policy = layers(("repo", text))
    for rung in RUNGS:
        effect = policy.resolve(rung, ANY).effect
        assert RANK[effect] >= RANK[BUILTIN_FLOOR[rung]], why


def test_a_file_that_is_not_toml_at_all_is_inert_and_marked(caplog):
    layer = parse_layer("this is not [ toml", name="user", source="<bad>")
    assert not layer.parsed
    assert layer.rules == ()
    assert len(layer.problems) == 1


def test_one_bad_key_leaves_the_rest_of_the_file_working():
    policy = layers(("user", '[effects]\nrung1 = "explode"\nrung2 = "ask"\n'))
    assert policy.resolve(1, ANY).effect == BUILTIN[1], "the bad key fell back"
    assert policy.resolve(2, ANY).effect == "ask", "the good key was dropped too"
    assert policy.degraded


def test_a_bad_file_is_logged_not_swallowed(caplog, tmp_path, monkeypatch):
    bad = tmp_path / "policy.toml"
    bad.write_text('[effects]\nrung3 = "explode"\n')
    monkeypatch.setenv("AGENT_PRESENCE_ORG_POLICY", str(bad))
    with caplog.at_level(logging.WARNING):
        policy = discover(include=("builtin", "org"))
    assert policy.degraded
    assert "explode" in caplog.text


# -- layer precedence --------------------------------------------------------


@pytest.mark.parametrize(
    "lower,higher",
    [("builtin", "org"), ("org", "repo"), ("repo", "user"), ("user", "session")],
)
def test_each_layer_beats_the_one_below_it(lower, higher):
    specs = []
    if lower != "builtin":
        specs.append((lower, '[effects]\nrung2 = "ask"\n'))
    specs.append((higher, '[effects]\nrung2 = "silent"\n'))
    policy = layers(*specs)
    assert policy.resolve(2, ANY).effect == "silent"
    assert policy.resolve(2, ANY).winning_layer == higher


def test_the_personal_file_beats_the_committed_one():
    # It is your machine and there is no enforcement. Pretending otherwise is
    # theatre — a user layer that lost to a repo layer would just teach people
    # to delete the repo file.
    policy = layers(
        ("repo", '[effects]\nrung3 = "deny"\n'),
        ("user", '[effects]\nrung3 = "context"\n'),
    )
    assert policy.resolve(3, ANY).effect == "context"


def test_a_lower_layer_still_answers_rungs_the_higher_one_is_silent_about():
    policy = layers(
        ("repo", '[effects]\nrung1 = "ask"\nrung2 = "ask"\n'),
        ("user", '[effects]\nrung2 = "silent"\n'),
    )
    assert policy.resolve(1, ANY).winning_layer == "repo"
    assert policy.resolve(2, ANY).winning_layer == "user"


# -- specificity inside a layer ----------------------------------------------


def test_a_path_rule_beats_the_blanket_rule():
    policy = layers(("user", """
[effects]
rung2 = "deny"

[[path]]
match = "src/generated/**"
rung2 = "silent"
"""))
    assert policy.resolve(2, "src/generated/api.py").effect == "silent"
    assert policy.resolve(2, "src/app.py").effect == "deny"


def test_the_longest_literal_prefix_wins():
    policy = layers(("user", """
[[path]]
match = "src/**"
rung2 = "ask"

[[path]]
match = "src/payments/**"
rung2 = "deny"
"""))
    assert policy.resolve(2, "src/payments/charge.py").effect == "deny"
    assert policy.resolve(2, "src/other/x.py").effect == "ask"


def test_file_order_is_not_what_decides_between_different_specificities():
    policy = layers(("user", """
[[path]]
match = "src/payments/**"
rung2 = "deny"

[[path]]
match = "src/**"
rung2 = "silent"
"""))
    assert policy.resolve(2, "src/payments/charge.py").effect == "deny"


def test_an_exact_specificity_tie_takes_the_later_rule_and_warns():
    policy = layers(("user", """
[[path]]
match = "src/**"
rung2 = "ask"

[[path]]
match = "src/*"
rung2 = "deny"
"""))
    resolution = policy.resolve(2, "src/app.py")
    assert resolution.effect == "deny"
    assert any("equally specific" in p for p in resolution.problems)


def test_a_star_does_not_cross_a_directory_separator():
    policy = layers(("user", '[[path]]\nmatch = "src/*.py"\nrung2 = "deny"\n'))
    assert policy.resolve(2, "src/app.py").effect == "deny"
    assert policy.resolve(2, "src/deep/app.py").effect == BUILTIN[2]


def test_a_double_star_does():
    policy = layers(("user", '[[path]]\nmatch = "src/**"\nrung2 = "deny"\n'))
    assert policy.resolve(2, "src/deep/app.py").effect == "deny"


def test_a_leading_double_star_also_matches_the_bare_name():
    policy = layers(("user", '[[path]]\nmatch = "**/conftest.py"\nrung2 = "deny"\n'))
    assert policy.resolve(2, "conftest.py").effect == "deny"
    assert policy.resolve(2, "a/b/conftest.py").effect == "deny"


# -- observer mode and floors ------------------------------------------------


def test_observer_mode_caps_the_layer_at_notify():
    policy = layers(("user", 'mode = "observer"\n[effects]\nrung3 = "deny"\n'))
    resolution = policy.resolve(3, ANY)
    assert resolution.effect == "notify"
    assert resolution.ceiling == "notify"


def test_observer_mode_does_not_quieten_rungs_it_says_nothing_about():
    policy = layers(("user", 'mode = "observer"\n[effects]\nrung1 = "deny"\n'))
    # Rung 3 was never claimed by the observer layer, so builtin still answers.
    assert policy.resolve(3, ANY).effect == "deny"


def test_a_floor_beats_the_observer_ceiling():
    # The one place the two orderings meet, and it has to be this way round:
    # observer is a personal preference, a floor is a statement by the people
    # responsible for the code.
    policy = layers(
        ("org", '[floor]\nrung3 = "ask"\n'),
        ("user", 'mode = "observer"\n[effects]\nrung3 = "deny"\n'),
    )
    resolution = policy.resolve(3, ANY)
    assert resolution.effect == "ask"
    assert resolution.ceiling == "notify"
    assert resolution.floor == "ask"
    assert resolution.floor_layer == "org"


def test_a_repo_floor_can_raise_an_org_floor_but_not_lower_it():
    policy = layers(
        ("org", '[floor]\nrung2 = "context"\n'),
        ("repo", '[floor]\nrung2 = "silent"\n'),
        ("user", '[effects]\nrung2 = "silent"\n'),
    )
    assert policy.resolve(2, ANY).effect == "context"

    raised = layers(
        ("org", '[floor]\nrung2 = "context"\n'),
        ("repo", '[floor]\nrung2 = "deny"\n'),
        ("user", '[effects]\nrung2 = "silent"\n'),
    )
    assert raised.resolve(2, ANY).effect == "deny"
    assert raised.resolve(2, ANY).floor_layer == "repo"


def test_a_floor_can_be_scoped_to_a_path():
    policy = layers(
        ("repo", """
[floor]
rung3 = "notify"

[[floor.path]]
match = "src/payments/**"
rung3 = "deny"
"""),
        ("user", '[effects]\nrung3 = "silent"\n'),
    )
    assert policy.resolve(3, "src/payments/charge.py").effect == "deny"
    assert policy.resolve(3, "src/app.py").effect == "notify"


@pytest.mark.parametrize("where", ["user", "session"])
def test_a_floor_outside_org_and_repo_parses_warns_and_is_ignored(where):
    # Silently dropping it would let someone believe they had hardened their
    # own setup.
    layer = parse_layer('[floor]\nrung3 = "deny"\n', name=where, source="<x>")
    assert any("floor" in p for p in layer.problems)
    policy = layers((where, '[floor]\nrung3 = "deny"\n[effects]\nrung3 = "silent"\n'))
    assert policy.resolve(3, ANY).effect == BUILTIN_FLOOR[3]


def test_the_builtin_floor_stops_a_silent_rung_three():
    # A silent rung 3 is the product lying. If that is what you want,
    # uninstall — or say mode = "observer", which says it honestly.
    policy = layers(("session", '[effects]\nrung3 = "silent"\n'))
    assert policy.resolve(3, ANY).effect == "notify"


# -- unattended promotion ----------------------------------------------------


def test_ask_becomes_deny_when_nobody_is_watching():
    policy = layers(("user", '[effects]\nrung3 = "ask"\n'))
    assert policy.resolve(3, ANY, unattended=False).effect == "ask"
    resolution = policy.resolve(3, ANY, unattended=True)
    assert resolution.effect == "deny"
    assert resolution.unattended_promoted


@pytest.mark.parametrize("effect", ["silent", "notify", "context", "deny"])
def test_nothing_else_is_promoted_by_being_unattended(effect):
    policy = layers(("user", f'[effects]\nrung2 = "{effect}"\n'))
    attended = policy.resolve(2, ANY, unattended=False).effect
    assert policy.resolve(2, ANY, unattended=True).effect == attended


# -- the two fail-safe properties --------------------------------------------

effect_names = st.sampled_from(EFFECTS)
rung_keys = st.integers(0, 4)
modes = st.sampled_from(["normal", "observer"])
layer_names = st.sampled_from(["org", "repo", "user", "session"])
globs = st.sampled_from(["src/**", "src/*.py", "**/test_*.py", "a/b/c.py", "**"])


@st.composite
def layer_text(draw):
    lines = [f'mode = "{draw(modes)}"', "[effects]"]
    for rung in draw(st.lists(rung_keys, unique=True, max_size=5)):
        lines.append(f'rung{rung} = "{draw(effect_names)}"')
    for _ in range(draw(st.integers(0, 2))):
        lines.append(f'\n[[path]]\nmatch = "{draw(globs)}"')
        lines.append(f'rung{draw(rung_keys)} = "{draw(effect_names)}"')
    if draw(st.booleans()):
        lines.append("\n[floor]")
        lines.append(f'rung{draw(rung_keys)} = "{draw(effect_names)}"')
    return "\n".join(lines)


@st.composite
def layer_stack(draw):
    return [
        (name, draw(layer_text()))
        for name in draw(st.lists(layer_names, unique=True, max_size=4))
    ]


@settings(max_examples=300, deadline=None)
@given(layer_stack(), rung_keys, st.booleans())
def test_no_stack_of_layers_ever_resolves_below_the_builtin_floor(
    stack, rung, unattended
):
    # The fail-safe invariant. There is no code path from a config file to a
    # quieter product: falling back is always to the builtin table, never to
    # "off".
    policy = layers(*stack)
    effect = policy.resolve(rung, "src/payments/charge.py", unattended=unattended).effect
    assert RANK[effect] >= RANK[BUILTIN_FLOOR[rung]], (
        f"{stack} resolved rung {rung} to {effect}"
    )


@settings(max_examples=200, deadline=None)
@given(
    st.text(max_size=200),
    layer_names,
    rung_keys,
)
def test_arbitrary_junk_in_a_policy_file_never_raises_and_never_lowers(
    text, name, rung
):
    layer = parse_layer(text, name=name, source="<fuzz>")
    policy = build_policy([builtin_layer(), layer])
    effect = policy.resolve(rung, ANY).effect
    assert RANK[effect] >= RANK[BUILTIN_FLOOR[rung]]


@settings(max_examples=200, deadline=None)
@given(st.sampled_from(["", "src/x.py", "a/b/c", "**weird**"]), st.booleans())
def test_rungs_0_to_2_never_interrupt_under_the_shipped_defaults(path, unattended):
    # Requirement 5. `ask` and `deny` are the only effects that set
    # permissionDecision, and neither is a shipped default below rung 3.
    policy = build_policy([builtin_layer()])
    for rung in (0, 1, 2):
        assert policy.resolve(rung, path, unattended=unattended).effect not in (
            "ask", "deny"
        )


def test_a_policy_may_still_raise_rung_one_if_somebody_asks_for_it():
    # The other half of requirement 5: quiet by default is a default, not a cap.
    policy = layers(("user", '[effects]\nrung1 = "deny"\n'))
    assert policy.resolve(1, ANY).effect == "deny"


# -- the trace ---------------------------------------------------------------


def test_the_resolution_names_the_layer_the_rule_and_the_file():
    policy = layers(("user", '[[path]]\nmatch = "src/**"\nrung3 = "ask"\n'))
    resolution = policy.resolve(3, "src/app.py")
    assert resolution.winning_layer == "user"
    assert resolution.winning_rule == "src/**"
    assert resolution.source == "<user>"
    reason = resolution.reason()
    assert "user" in reason and "src/**" in reason and "ask" in reason


def test_the_reason_explains_a_ceiling_and_a_floor():
    policy = layers(
        ("org", '[floor]\nrung3 = "ask"\n'),
        ("user", 'mode = "observer"\n[effects]\nrung3 = "deny"\n'),
    )
    reason = policy.resolve(3, ANY).reason()
    assert "observer" in reason
    assert "floor" in reason


def test_the_reason_explains_the_unattended_promotion():
    policy = layers(("user", '[effects]\nrung3 = "ask"\n'))
    assert "nobody is watching" in policy.resolve(3, ANY, unattended=True).reason()


def test_a_blanket_rule_says_so():
    policy = layers(("user", '[effects]\nrung3 = "ask"\n'))
    assert policy.resolve(3, ANY).winning_rule == "blanket"


# -- tables and the compiled cache -------------------------------------------


def test_table_for_agrees_with_resolve_on_every_rung():
    policy = layers(("user", '[effects]\nrung1 = "ask"\nrung3 = "context"\n'))
    table = policy.table_for(ANY)
    for rung in RUNGS:
        assert table[rung] == policy.resolve(rung, ANY).effect


def test_effect_tables_clamp_elementwise():
    low = EffectTable(("silent",) * 5)
    assert low.raised_to(BUILTIN_FLOOR).names() == BUILTIN_FLOOR.names()
    # A cap only pulls down what is above it. rung 0 and rung 4 are already
    # quieter than notify and stay where they are.
    assert BUILTIN.capped_at("notify").names() == [
        "silent", "notify", "notify", "notify", "silent"
    ]
    assert EffectTable(("deny",) * 5).capped_at("silent").names() == ["silent"] * 5


def test_the_compiled_blob_is_one_line_of_json_the_daemon_can_read(tmp_path):
    policy = layers(("user", '[effects]\nrung3 = "ask"\n'))
    blob = compile_runtime(policy, path=ANY, unattended=False)
    assert blob["table"][3] == "ask"
    assert blob["floor"] == BUILTIN_FLOOR.names()
    assert blob["schema"] == 1

    dest = tmp_path / "runtime" / "policy.json"
    write_runtime_cache(dest, blob)
    text = dest.read_text()
    assert text.count("\n") == 1
    assert json.loads(text) == blob


def test_writing_the_cache_leaves_no_temp_files_behind(tmp_path):
    dest = tmp_path / "policy.json"
    for _ in range(3):
        write_runtime_cache(dest, compile_runtime(build_policy([builtin_layer()])))
    assert [p.name for p in tmp_path.iterdir()] == ["policy.json"]


def test_the_cache_path_follows_xdg_runtime_dir():
    assert runtime_cache_path({"XDG_RUNTIME_DIR": "/run/user/1000"}) == pathlib.Path(
        "/run/user/1000/agent-presence.policy.json"
    )


def test_the_cache_path_still_has_somewhere_to_go_with_no_xdg_runtime_dir():
    assert runtime_cache_path({}).name == "agent-presence.policy.json"


def test_the_digest_moves_when_a_rule_changes_and_not_otherwise():
    one = layers(("user", '[effects]\nrung3 = "ask"\n'))
    same = layers(("user", '[effects]\nrung3 = "ask"\n'))
    other = layers(("user", '[effects]\nrung3 = "deny"\n'))
    assert one.digest == same.digest
    assert one.digest != other.digest


# -- discovery and live reload -----------------------------------------------


def test_discover_reads_each_layer_from_its_documented_place(tmp_path, monkeypatch):
    repo = tmp_path / "repo"
    (repo / ".agent-presence").mkdir(parents=True)
    (repo / ".agent-presence" / "policy.toml").write_text(
        '[effects]\nrung1 = "ask"\n'
    )
    config = tmp_path / "config"
    (config / "agent-presence").mkdir(parents=True)
    (config / "agent-presence" / "policy.toml").write_text(
        '[effects]\nrung2 = "ask"\n'
    )
    session = tmp_path / "session.toml"
    session.write_text('[effects]\nrung3 = "context"\n')

    policy = discover(
        str(repo),
        env={
            "XDG_CONFIG_HOME": str(config),
            "AGENT_PRESENCE_POLICY": str(session),
        },
    )
    assert policy.resolve(1, ANY).winning_layer == "repo"
    assert policy.resolve(2, ANY).winning_layer == "user"
    assert policy.resolve(3, ANY).effect == "context"


def test_a_session_env_var_beats_the_session_file(tmp_path):
    session = tmp_path / "session.toml"
    session.write_text('[effects]\nrung3 = "context"\n')
    policy = discover(
        str(tmp_path),
        env={
            "AGENT_PRESENCE_POLICY": str(session),
            "AGENT_PRESENCE_POLICY_RUNG3": "ask",
            "XDG_CONFIG_HOME": str(tmp_path / "nothing"),
        },
    )
    assert policy.resolve(3, ANY).effect == "ask"


def test_a_session_env_var_works_with_no_session_file(tmp_path):
    policy = discover(
        str(tmp_path),
        env={
            "AGENT_PRESENCE_POLICY_RUNG2": "ask",
            "XDG_CONFIG_HOME": str(tmp_path / "nothing"),
        },
    )
    assert policy.resolve(2, ANY).effect == "ask"


def test_a_bad_session_env_var_is_reported_not_obeyed(tmp_path):
    policy = discover(
        str(tmp_path),
        env={
            "AGENT_PRESENCE_POLICY_RUNG2": "explode",
            "XDG_CONFIG_HOME": str(tmp_path / "nothing"),
        },
    )
    assert policy.resolve(2, ANY).effect == BUILTIN[2]
    assert policy.degraded


def test_a_missing_file_everywhere_is_not_degraded(tmp_path):
    policy = discover(
        str(tmp_path), env={"XDG_CONFIG_HOME": str(tmp_path / "nothing")}
    )
    assert not policy.degraded
    assert policy.problems == ()


def test_editing_the_file_takes_effect_without_a_restart(tmp_path):
    path = tmp_path / "policy.toml"
    path.write_text('[effects]\nrung3 = "ask"\n')
    clock = VirtualClock()
    live = PolicyFile([("user", path)], clock)
    assert live.current().resolve(3, ANY).effect == "ask"

    path.write_text('[effects]\nrung3 = "context"\n')
    clock.advance(2.0)
    assert live.current().resolve(3, ANY).effect == "context"


def test_the_file_is_not_restatted_on_every_call(tmp_path):
    path = tmp_path / "policy.toml"
    path.write_text('[effects]\nrung3 = "ask"\n')
    clock = VirtualClock()
    live = PolicyFile([("user", path)], clock)
    first = live.current()
    path.write_text('[effects]\nrung3 = "context"\n')
    # Inside the recheck window: the edit is real but nothing has looked yet.
    assert live.current() is first


def test_a_file_that_stops_parsing_keeps_the_last_good_table(tmp_path, caplog):
    path = tmp_path / "policy.toml"
    path.write_text('[effects]\nrung3 = "ask"\n')
    clock = VirtualClock()
    live = PolicyFile([("user", path)], clock)
    assert live.current().resolve(3, ANY).effect == "ask"

    path.write_text("this is not [ toml")
    clock.advance(2.0)
    with caplog.at_level(logging.WARNING):
        broken = live.current()

    assert broken.resolve(3, ANY).effect == "ask", "protection was silently dropped"
    assert broken.degraded
    assert broken.problems, "a degradation with nothing to say is not loud"
    assert "policy" in caplog.text.lower()


def test_a_file_that_starts_broken_falls_back_to_builtin_and_says_so(tmp_path):
    path = tmp_path / "policy.toml"
    path.write_text("this is not [ toml")
    live = PolicyFile([("user", path)], VirtualClock())
    policy = live.current()
    assert policy.resolve(3, ANY).effect == BUILTIN[3]
    assert policy.degraded


def test_a_deleted_file_falls_back_without_pretending_it_is_fine(tmp_path):
    path = tmp_path / "policy.toml"
    path.write_text('[effects]\nrung3 = "context"\n')
    clock = VirtualClock()
    live = PolicyFile([("user", path)], clock)
    assert live.current().resolve(3, ANY).effect == "context"

    path.unlink()
    clock.advance(2.0)
    policy = live.current()
    assert policy.resolve(3, ANY).effect == BUILTIN[3]
    assert not policy.degraded, "an absent file is the documented default"


def test_the_relay_stack_is_builtin_plus_org_only(tmp_path):
    org = tmp_path / "org.toml"
    org.write_text('[floor]\nrung2 = "context"\n')
    policy = discover(
        str(tmp_path),
        env={"AGENT_PRESENCE_ORG_POLICY": str(org)},
        include=("builtin", "org"),
    )
    assert {layer.name for layer in policy.layers} == {"builtin", "org"}
    assert policy.floor_table(ANY)[2] == "context"
