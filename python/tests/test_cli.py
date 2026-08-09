"""The `ap` terminal surface.

Every test here starts a real process and reads its real stdout and its real
exit code. Calling the command functions directly would prove the functions
work and prove nothing about the thing a person types, which is the whole
deliverable: argument parsing, exit codes, what lands on stdout versus stderr,
and whether colour stays out of a pipe.

Each test gets a whole fake machine — its own repo, its own $HOME, its own
runtime directory — so nothing reads the developer's real policy file and
nothing is order-dependent.
"""

from __future__ import annotations

import json
import os
import shutil
import socket
import subprocess
import sys
import tempfile
from pathlib import Path

import pytest

PYTHON_ROOT = Path(__file__).resolve().parents[1]
BIN_DIR = Path(sys.executable).parent
TIMEOUT_S = 60.0

BUILTIN_TABLE = ["silent", "notify", "context", "deny", "silent"]


class Box:
    """One machine: a repo to stand in, a home to configure, a runtime dir."""

    def __init__(self, repo: Path, home: Path, run: Path) -> None:
        self.repo = repo
        self.home = home
        self.run = run
        self.config = home / ".config"
        self.user_policy = self.config / "agent-presence" / "policy.toml"
        self.repo_policy = repo / ".agent-presence" / "policy.toml"
        self.roster = repo / ".agent-presence" / "principals.toml"
        self.snapshot = run / "agent-presence.json"
        self.sock = run / "agent-presence.sock"
        self.cache = run / "agent-presence.policy.json"
        self.journal = run / "agent-presence.decisions.jsonl"

    @property
    def env(self) -> dict[str, str]:
        env = {k: v for k, v in os.environ.items()
               if not k.startswith("AGENT_PRESENCE_") and k != "NO_COLOR"}
        env.update({
            "HOME": str(self.home),
            "XDG_CONFIG_HOME": str(self.config),
            "XDG_RUNTIME_DIR": str(self.run),
            "TMPDIR": str(self.run),
            # A pipe is not a tty anyway; this pins it for anyone running the
            # suite under a pty.
            "TERM": "dumb",
        })
        return env

    def ap(self, *argv: str, stdin: str | None = None,
           env: dict[str, str] | None = None) -> subprocess.CompletedProcess:
        return subprocess.run(
            [sys.executable, "-m", "agent_presence.cli", *argv],
            cwd=self.repo, input=stdin, capture_output=True, text=True,
            timeout=TIMEOUT_S, env=env or self.env,
        )

    def write_user_policy(self, text: str) -> Path:
        self.user_policy.parent.mkdir(parents=True, exist_ok=True)
        self.user_policy.write_text(text, encoding="utf-8")
        return self.user_policy

    def write_repo_policy(self, text: str) -> Path:
        self.repo_policy.parent.mkdir(parents=True, exist_ok=True)
        self.repo_policy.write_text(text, encoding="utf-8")
        return self.repo_policy


@pytest.fixture
def box(tmp_path):
    repo = tmp_path / "repo"
    (repo / ".git").mkdir(parents=True)
    home = tmp_path / "home"
    home.mkdir()
    # Short, because a unix socket path is capped near 104 bytes and pytest's
    # tmp_path is nowhere near short enough to hold one.
    run = Path(tempfile.mkdtemp(prefix="ap", dir="/tmp"))
    try:
        yield Box(repo, home, run)
    finally:
        shutil.rmtree(run, ignore_errors=True)


@pytest.fixture
def listening(box):
    """The two sockets presenced serves, actually accepting connections."""
    servers = []
    for path in (box.sock, Path(str(box.sock) + ".decide")):
        server = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        server.bind(str(path))
        server.listen(1)
        servers.append(server)
    try:
        yield
    finally:
        for server in servers:
            server.close()


# -- help and usage ---------------------------------------------------------


def test_bare_ap_prints_help_and_exits_2(box):
    done = box.ap()
    assert done.returncode == 2
    assert "usage: ap" in done.stdout
    assert "policy" in done.stdout


def test_help_names_every_command(box):
    done = box.ap("--help")
    assert done.returncode == 0
    for command in ("policy", "why", "who", "principals", "token", "doctor"):
        assert command in done.stdout


def test_a_group_with_no_subcommand_prints_its_own_help(box):
    done = box.ap("policy")
    assert done.returncode == 2
    assert "show" in done.stdout and "explain" in done.stdout


def test_an_unknown_command_is_refused(box):
    done = box.ap("frobnicate")
    assert done.returncode == 2
    assert done.stdout == ""


# -- show -------------------------------------------------------------------


def test_a_machine_with_no_config_resolves_to_the_builtin_table(box):
    done = box.ap("policy", "show", "--effective", "--json")
    assert done.returncode == 0, done.stderr
    blob = json.loads(done.stdout)
    assert blob["table"] == BUILTIN_TABLE
    assert blob["degraded"] is False
    assert [r["layer"] for r in blob["rungs"]] == ["builtin"] * 5


def test_effective_output_names_where_each_value_came_from(box):
    box.write_user_policy('schema = 1\n[effects]\nrung3 = "ask"\n')
    done = box.ap("policy", "show", "--effective")
    assert done.returncode == 0, done.stderr
    assert "ask" in done.stdout
    # The point of the view: not just the value, but the file it is written in.
    assert str(box.user_policy) in done.stdout
    assert "user" in done.stdout


def test_show_names_the_layers_that_have_no_file(box):
    done = box.ap("policy", "show", "--effective")
    assert "(absent)" in done.stdout
    assert str(box.user_policy) in done.stdout


def test_show_layer_reports_an_empty_layer_without_failing(box):
    done = box.ap("policy", "show", "--layer", "user")
    assert done.returncode == 0
    assert "nothing set" in done.stdout


def test_show_layer_lists_the_rules_as_written(box):
    box.write_user_policy(
        'schema = 1\n[effects]\nrung1 = "context"\n\n'
        '[[path]]\nmatch = "src/pay/**"\nrung3 = "deny"\n'
    )
    done = box.ap("policy", "show", "--layer", "user")
    assert done.returncode == 0, done.stderr
    assert "rung1=context" in done.stdout
    assert "src/pay/**" in done.stdout


def test_policy_path_prints_the_file_to_edit(box):
    done = box.ap("policy", "path", "--layer", "user")
    assert done.returncode == 0
    assert done.stdout.strip() == str(box.user_policy)


def test_policy_path_fails_loudly_when_there_is_no_session_file(box):
    done = box.ap("policy", "path", "--layer", "session")
    assert done.returncode == 1
    assert "AGENT_PRESENCE_POLICY" in done.stderr


# -- set and unset ----------------------------------------------------------


def test_set_writes_the_file_and_the_next_read_sees_it(box):
    written = box.ap("policy", "set", "rung3=ask")
    assert written.returncode == 0, written.stderr
    assert str(box.user_policy) in written.stdout

    shown = box.ap("policy", "show", "--effective", "--json")
    blob = json.loads(shown.stdout)
    assert blob["table"][3] == "ask"
    assert blob["rungs"][3]["layer"] == "user"


def test_set_then_unset_restores_the_original_bytes(box):
    original = (
        "schema = 1\n\n"
        "# Generated code is not worth a conversation.\n"
        "[[path]]\n"
        'match = "src/generated/**"\n'
        'rung3 = "notify"\n'
    )
    box.write_user_policy(original)
    assert box.ap("policy", "set", "rung3=ask").returncode == 0
    assert box.ap("policy", "unset", "rung3").returncode == 0
    assert box.user_policy.read_text() == original


def test_set_leaves_comments_and_key_order_alone(box):
    box.write_user_policy(
        "schema = 1\n"
        "\n"
        "[effects]\n"
        '# rung 3 is a fact, not a guess, so it is worth stopping for\n'
        'rung3 = "deny"   # trailing note\n'
        'rung1 = "notify"\n'
    )
    assert box.ap("policy", "set", "rung3=ask").returncode == 0
    text = box.user_policy.read_text()
    assert "# rung 3 is a fact, not a guess, so it is worth stopping for" in text
    assert '# trailing note' in text
    assert text.index("rung3") < text.index("rung1")
    assert 'rung3 = "ask"' in text


def test_unset_says_so_when_there_was_nothing_to_remove(box):
    box.write_user_policy("schema = 1\n")
    done = box.ap("policy", "unset", "rung2")
    assert done.returncode == 0
    assert "nothing to remove" in done.stdout


def test_a_path_rule_only_applies_to_paths_that_match(box):
    assert box.ap("policy", "set", "rung3=notify",
                  "--path", "src/generated/**").returncode == 0

    inside = json.loads(box.ap("policy", "explain", "src/generated/api.py",
                               "--rung", "3", "--json").stdout)
    outside = json.loads(box.ap("policy", "explain", "src/auth.py",
                                "--rung", "3", "--json").stdout)
    assert inside["effect"] == "notify"
    assert inside["rule"] == "src/generated/**"
    assert outside["effect"] == "deny"
    assert outside["layer"] == "builtin"


@pytest.mark.parametrize(
    ("assignment", "expected"),
    [
        ("rung3=loud", "not an effect"),
        ("rung9=ask", "rung 9 does not exist"),
        ("nonsense=ask", "is not a rung"),
        ("rung3", "expected KEY=VALUE"),
        ("mode=sideways", "mode must be one of"),
    ],
)
def test_set_refuses_nonsense_with_a_message_that_says_what_is_allowed(
    box, assignment, expected
):
    done = box.ap("policy", "set", assignment)
    assert done.returncode == 2
    assert expected in done.stderr
    assert not box.user_policy.exists()


def test_set_refuses_a_floor_in_a_layer_that_would_ignore_it(box):
    done = box.ap("policy", "set", "rung3=deny", "--floor", "--layer", "user")
    assert done.returncode == 1
    assert "org and repo" in done.stderr
    assert not box.user_policy.exists()


def test_a_repo_floor_beats_a_quieter_personal_setting(box):
    box.write_repo_policy('schema = 1\n[floor]\nrung3 = "deny"\n')
    box.write_user_policy('schema = 1\n[effects]\nrung3 = "notify"\n')
    blob = json.loads(box.ap("policy", "show", "--effective", "--json").stdout)
    assert blob["rungs"][3]["base"] == "notify"
    assert blob["rungs"][3]["effect"] == "deny"
    assert blob["rungs"][3]["floor_layer"] == "repo"


def test_nothing_configurable_drops_rung_three_below_the_builtin_floor(box):
    box.write_user_policy('schema = 1\n[effects]\nrung3 = "silent"\n')
    blob = json.loads(box.ap("policy", "show", "--effective", "--json").stdout)
    assert blob["rungs"][3]["base"] == "silent"
    assert blob["rungs"][3]["effect"] == "notify"
    assert blob["rungs"][3]["floor"] == "notify"


def test_rungs_zero_to_two_stay_quiet_under_the_shipped_defaults(box):
    blob = json.loads(box.ap("policy", "show", "--effective", "--json").stdout)
    for rung in (0, 1, 2):
        assert blob["table"][rung] in ("silent", "notify", "context")


# -- explain ----------------------------------------------------------------


def test_explain_names_the_winner_the_ceiling_and_the_floor(box):
    box.write_user_policy('schema = 1\n[effects]\nrung3 = "ask"\n')
    done = box.ap("policy", "explain", "src/auth.py", "--rung", "3")
    assert done.returncode == 0, done.stderr
    assert "winner" in done.stdout
    assert "ceiling" in done.stdout
    assert "floor" in done.stdout
    assert str(box.user_policy) in done.stdout
    assert "ask" in done.stdout


def test_explain_shows_the_layers_that_lost(box):
    box.write_user_policy('schema = 1\n[effects]\nrung3 = "ask"\n')
    done = box.ap("policy", "explain", "src/auth.py", "--rung", "3")
    assert "considered" in done.stdout
    assert "outranked" in done.stdout
    blob = json.loads(box.ap("policy", "explain", "src/auth.py", "--rung", "3",
                             "--json").stdout)
    outcomes = {row["layer"]: row["outcome"] for row in blob["considered"]}
    assert outcomes["user"] == "winner"
    assert outcomes["builtin"] == "outranked"


def test_explain_shows_ask_becoming_deny_when_nobody_is_watching(box):
    box.write_user_policy('schema = 1\n[effects]\nrung3 = "ask"\n')
    blob = json.loads(box.ap("policy", "explain", "src/auth.py", "--rung", "3",
                             "--unattended", "--json").stdout)
    assert blob["base"] == "ask"
    assert blob["effect"] == "deny"
    assert blob["unattended_promoted"] is True
    assert "nobody is watching" in blob["reason"]


def test_explain_refuses_a_rung_that_does_not_exist(box):
    done = box.ap("policy", "explain", "src/auth.py", "--rung", "7")
    assert done.returncode == 2
    assert "rungs are 0 through 4" in done.stderr


# -- check ------------------------------------------------------------------


def test_check_exits_zero_on_a_clean_stack(box):
    box.write_user_policy('schema = 1\n[effects]\nrung3 = "ask"\n')
    done = box.ap("policy", "check")
    assert done.returncode == 0, done.stdout
    assert "every layer parses" in done.stdout


@pytest.mark.parametrize(
    ("body", "line", "expected"),
    [
        ('schema = 1\nmode = "quiet"\n', 2, "mode = 'quiet'"),
        ('schema = 1\n[effects]\nrung3 = "loud"\n', 3, "rung3 = 'loud'"),
        ('schema = 1\n[effects]\nrung9 = "deny"\n', 3, "unknown key 'rung9'"),
        ('schema = 7\n', 1, "schema = 7"),
        ('schema = 1\n[[path]]\nrung3 = "deny"\n', 2, "no usable `match`"),
        ('schema = 1\n[[path]]\nmatch = "src/[unclosed"\nrung3 = "deny"\n',
         3, "not a valid glob"),
        ('schema = 1\n[floor]\nrung3 = "deny"\n', 2, "org and repo"),
    ],
)
def test_check_reports_the_file_and_the_line_of_each_problem(
    box, body, line, expected
):
    box.write_user_policy(body)
    done = box.ap("policy", "check", "--layer", "user")
    assert done.returncode == 1, done.stdout
    assert f"{box.user_policy}:{line}:" in done.stdout
    assert expected in done.stdout


def test_check_reports_the_line_of_a_toml_syntax_error(box):
    box.write_user_policy('schema = 1\n[effects\nrung3 = "ask"\n')
    done = box.ap("policy", "check", "--layer", "user")
    assert done.returncode == 1
    assert f"{box.user_policy}:2:" in done.stdout
    assert "not valid TOML" in done.stdout


def test_check_warns_without_failing_when_a_rung_is_made_to_interrupt(box):
    box.write_user_policy('schema = 1\n[effects]\nrung1 = "deny"\n')
    done = box.ap("policy", "check", "--layer", "user")
    assert done.returncode == 0, done.stdout
    assert "warn" in done.stdout
    assert f"{box.user_policy}:3:" in done.stdout
    assert "interrupts" in done.stdout


def test_check_warns_when_observer_mode_would_cap_nothing(box):
    box.write_user_policy('schema = 1\nmode = "observer"\n')
    done = box.ap("policy", "check", "--layer", "user")
    assert done.returncode == 0, done.stdout
    assert "never wins a rung" in done.stdout


def test_check_warns_about_two_rules_of_equal_specificity(box):
    box.write_user_policy(
        'schema = 1\n'
        '[[path]]\nmatch = "src/*.py"\nrung3 = "ask"\n\n'
        '[[path]]\nmatch = "src/*.go"\nrung3 = "notify"\n'
    )
    done = box.ap("policy", "check", "--layer", "user")
    assert done.returncode == 0, done.stdout
    assert "same specificity" in done.stdout


def test_check_json_carries_the_line_numbers(box):
    box.write_user_policy('schema = 1\n[effects]\nrung3 = "loud"\n')
    done = box.ap("policy", "check", "--json")
    assert done.returncode == 1
    blob = json.loads(done.stdout)
    assert blob["degraded"] is True
    user = next(l for l in blob["layers"] if l["name"] == "user")
    assert user["findings"][0]["line"] == 3
    assert user["findings"][0]["severity"] == "error"
    assert user["unaccounted"] == []


def test_a_degraded_layer_keeps_the_builtin_value_rather_than_going_quiet(box):
    box.write_user_policy('schema = 1\n[effects]\nrung3 = "loud"\n')
    blob = json.loads(box.ap("policy", "show", "--effective", "--json").stdout)
    assert blob["degraded"] is True
    assert blob["table"][3] == "deny"


# -- compile ----------------------------------------------------------------


def test_compile_writes_the_blob_the_daemon_reads(box):
    box.write_user_policy('schema = 1\n[effects]\nrung3 = "ask"\n')
    done = box.ap("policy", "compile")
    assert done.returncode == 0, done.stderr
    assert str(box.cache) in done.stdout

    blob = json.loads(box.cache.read_text())
    assert blob["table"] == ["silent", "notify", "context", "ask", "silent"]
    assert blob["floor"][3] == "notify"
    assert blob["schema"] == 1


def test_compile_can_be_pointed_somewhere_else(box):
    dest = box.run / "elsewhere.json"
    assert box.ap("policy", "compile", "-o", str(dest)).returncode == 0
    assert json.loads(dest.read_text())["table"] == BUILTIN_TABLE


# -- who --------------------------------------------------------------------


def test_who_says_so_when_the_daemon_is_not_running(box):
    done = box.ap("who")
    assert done.returncode == 0
    assert "not running" in done.stdout


def test_who_lists_the_peers_in_the_snapshot(box):
    box.snapshot.write_text(json.dumps({"peers": [
        {"human": "sara", "verb": "edit", "path": "src/auth.py"},
        {"human": "ravi", "verb": "read", "path": "src/db.py"},
    ]}))
    done = box.ap("who")
    assert done.returncode == 0, done.stderr
    assert "sara" in done.stdout and "src/auth.py" in done.stdout
    assert "ravi" in done.stdout


def test_who_reports_a_degraded_policy_and_exits_nonzero(box):
    box.snapshot.write_text(json.dumps({
        "peers": [], "policy_degraded": True,
        "policy_problem": "policy.toml:3: rung3 = 'loud' is not an effect",
    }))
    done = box.ap("who")
    assert done.returncode == 1
    assert "policy degraded" in done.stdout
    assert "rung3" in done.stdout


def test_who_json_is_parseable_with_no_snapshot(box):
    done = box.ap("who", "--json")
    assert done.returncode == 0
    assert json.loads(done.stdout)["present"] is False


# -- why --------------------------------------------------------------------


def test_why_is_quiet_and_exits_zero_with_no_journal(box):
    done = box.ap("why")
    assert done.returncode == 0
    assert "no decisions recorded yet" in done.stdout


def test_why_renders_the_journal(box):
    box.journal.write_text("\n".join(json.dumps(row) for row in [
        {"at_ms": 1754600000000, "rung": 3, "effect": "deny",
         "path": "src/auth.py", "holder": "a2", "human": "sara",
         "intent": "add rate limiting",
         "reason": "rung 3 resolves to deny: builtin blanket rule says deny"},
        {"at_ms": 1754600001000, "rung": 1, "effect": "notify",
         "path": "src/db.py"},
    ]) + "\n")
    done = box.ap("why")
    assert done.returncode == 0, done.stderr
    assert "src/auth.py" in done.stdout
    assert "held by sara" in done.stdout
    assert "add rate limiting" in done.stdout
    assert "src/db.py" in done.stdout


def test_why_skips_a_torn_line_instead_of_crashing(box):
    good = json.dumps({"at_ms": 1, "rung": 3, "effect": "deny",
                       "path": "src/auth.py"})
    box.journal.write_text(good + '\n{"at_ms": 2, "rung"\n')
    done = box.ap("why", "--json")
    assert done.returncode == 0, done.stderr
    assert [r["path"] for r in json.loads(done.stdout)] == ["src/auth.py"]


def test_why_takes_a_count(box):
    lines = [json.dumps({"at_ms": i, "rung": 3, "effect": "deny",
                         "path": f"src/f{i}.py"}) for i in range(5)]
    box.journal.write_text("\n".join(lines) + "\n")
    done = box.ap("why", "-n", "2", "--json")
    assert [r["path"] for r in json.loads(done.stdout)] == \
        ["src/f3.py", "src/f4.py"]


# -- doctor -----------------------------------------------------------------


def test_doctor_exits_one_when_the_runtime_cache_is_missing(box):
    done = box.ap("doctor")
    assert done.returncode == 1
    assert str(box.cache) in done.stdout
    assert "ap policy compile" in done.stdout


def test_doctor_passes_once_everything_is_in_place(box, listening):
    box.snapshot.write_text('{"peers":[]}')
    box.journal.write_text("")
    assert box.ap("policy", "compile").returncode == 0
    done = box.ap("doctor")
    assert done.returncode == 0, done.stdout
    assert "everything checks out" in done.stdout


def test_doctor_notices_a_cache_that_is_one_edit_behind(box, listening):
    box.snapshot.write_text('{"peers":[]}')
    assert box.ap("policy", "compile").returncode == 0
    assert box.ap("policy", "set", "rung3=ask").returncode == 0
    done = box.ap("doctor")
    assert done.returncode == 1
    assert "one edit behind" in done.stdout


def test_doctor_fails_on_a_broken_policy_file_and_names_the_line(box, listening):
    box.snapshot.write_text('{"peers":[]}')
    box.write_user_policy('schema = 1\n[effects]\nrung3 = "loud"\n')
    assert box.ap("policy", "compile").returncode == 0
    done = box.ap("doctor")
    assert done.returncode == 1
    assert f"{box.user_policy}:3:" in done.stdout


def test_doctor_json_lists_every_check(box):
    done = box.ap("doctor", "--json")
    assert done.returncode == 1
    blob = json.loads(done.stdout)
    assert blob["ok"] is False
    names = {c["name"] for c in blob["checks"]}
    assert {"event socket", "runtime cache", "roster", "policy:user"} <= names


# -- principals and tokens --------------------------------------------------


def test_principals_add_prints_the_token_once_and_stores_only_its_hash(box):
    done = box.ap("principals", "add", "sara",
                  "--attended", "normal", "--unattended", "elevated")
    assert done.returncode == 0, done.stderr

    token = next(line.split()[-1] for line in done.stdout.splitlines()
                 if line.strip().startswith("token "))
    roster = box.roster.read_text()
    assert token not in roster
    assert 'id           = "sara"' in roster

    hashed = box.ap("token", "hash", token)
    assert hashed.returncode == 0
    assert hashed.stdout.strip() in roster


def test_principals_list_shows_the_band(box):
    assert box.ap("principals", "add", "release-bot", "--attended", "critical",
                  "--unattended", "critical").returncode == 0
    done = box.ap("principals", "list")
    assert done.returncode == 0, done.stderr
    assert "release-bot" in done.stdout
    assert done.stdout.count("critical") == 2


def test_principals_list_says_so_when_there_is_no_roster(box):
    done = box.ap("principals", "list")
    assert done.returncode == 0
    assert "everyone is normal" in done.stdout


def test_principals_add_refuses_an_inverted_band(box):
    done = box.ap("principals", "add", "sara", "--attended", "critical",
                  "--unattended", "background")
    assert done.returncode == 2
    assert "the band runs the other way" in done.stderr
    assert not box.roster.exists()


def test_principals_add_refuses_a_duplicate(box):
    assert box.ap("principals", "add", "sara").returncode == 0
    done = box.ap("principals", "add", "sara")
    assert done.returncode == 1
    assert "already in" in done.stderr


def test_a_broken_roster_is_reported_and_exits_nonzero(box):
    box.roster.parent.mkdir(parents=True, exist_ok=True)
    box.roster.write_text('version = 1\n[[principal]]\nid = "sara"\n')
    done = box.ap("principals", "list")
    assert done.returncode == 1
    assert "token_sha256" in done.stdout


def test_token_mint_produces_something_new_each_time(box):
    first = box.ap("token", "mint").stdout.strip()
    second = box.ap("token", "mint").stdout.strip()
    assert first and first != second


def test_token_hash_reads_stdin_when_given_no_argument(box):
    from_arg = box.ap("token", "hash", "hunter2").stdout.strip()
    from_stdin = box.ap("token", "hash", stdin="hunter2\n").stdout.strip()
    assert from_arg == from_stdin
    assert len(from_arg) == 64


# -- colour -----------------------------------------------------------------


def test_no_colour_reaches_a_pipe(box):
    done = box.ap("policy", "show", "--effective")
    assert "\033[" not in done.stdout


def test_colour_always_paints_even_into_a_pipe(box):
    done = box.ap("--color", "always", "policy", "show", "--effective")
    assert "\033[" in done.stdout


def test_json_is_never_painted(box):
    done = box.ap("--color", "always", "policy", "show", "--effective", "--json")
    assert "\033[" not in done.stdout
    json.loads(done.stdout)


def test_color_always_beats_no_color_in_the_environment(box):
    env = box.env
    env["NO_COLOR"] = "1"
    done = box.ap("--color", "always", "policy", "show", "--effective", env=env)
    # An explicit flag is an instruction. NO_COLOR governs the auto case.
    assert "\033[" in done.stdout


def test_color_never_is_bare_even_with_a_flag_saying_otherwise(box):
    done = box.ap("--color", "never", "policy", "show", "--effective")
    assert "\033[" not in done.stdout


# -- the session layer ------------------------------------------------------


def test_a_session_env_var_beats_the_user_file(box):
    box.write_user_policy('schema = 1\n[effects]\nrung3 = "notify"\n')
    env = box.env
    env["AGENT_PRESENCE_POLICY_RUNG3"] = "ask"
    blob = json.loads(box.ap("policy", "show", "--effective", "--json",
                             env=env).stdout)
    assert blob["rungs"][3]["effect"] == "ask"
    assert blob["rungs"][3]["layer"] == "session"


def test_a_bad_session_env_var_is_reported_rather_than_swallowed(box):
    env = box.env
    env["AGENT_PRESENCE_POLICY_RUNG3"] = "loud"
    done = box.ap("policy", "check", env=env)
    assert done.returncode == 1
    assert "AGENT_PRESENCE_POLICY_RUNG3" in done.stdout


def test_a_session_policy_file_can_be_written_and_read(box):
    session = box.run / "session.toml"
    env = box.env
    env["AGENT_PRESENCE_POLICY"] = str(session)
    assert box.ap("policy", "set", "rung2=ask", "--layer", "session",
                  env=env).returncode == 0
    blob = json.loads(box.ap("policy", "show", "--effective", "--json",
                             env=env).stdout)
    assert blob["rungs"][2]["effect"] == "ask"
    assert blob["rungs"][2]["layer"] == "session"
    assert box.ap("policy", "path", "--layer", "session",
                  env=env).stdout.strip() == str(session)


# -- the installed binary ---------------------------------------------------


def test_the_installed_ap_script_is_the_same_program(box):
    script = BIN_DIR / "ap"
    assert script.exists(), (
        f"{script} is missing — reinstall with `pip install -e '.[dev]'`"
    )
    done = subprocess.run(
        [str(script), "policy", "show", "--effective", "--json"],
        cwd=box.repo, capture_output=True, text=True, timeout=TIMEOUT_S,
        env=box.env,
    )
    assert done.returncode == 0, done.stderr
    assert json.loads(done.stdout)["table"] == BUILTIN_TABLE


def test_the_directory_flag_moves_where_the_repo_is_looked_for(box, tmp_path):
    outside = tmp_path / "outside"
    outside.mkdir()
    done = subprocess.run(
        [sys.executable, "-m", "agent_presence.cli", "-C", str(box.repo),
         "doctor", "--json"],
        cwd=outside, capture_output=True, text=True, timeout=TIMEOUT_S,
        env=box.env,
    )
    checks = {c["name"]: c["detail"] for c in json.loads(done.stdout)["checks"]}
    assert str(box.repo) in checks["repo"]


# -- the principal this machine presents -------------------------------------
#
# `ap principals add` prints a token once and says: put it in
# ~/.config/agent-presence/token, or $AGENT_PRESENCE_TOKEN, on the machine that
# runs as this principal. Nothing checked whether you did, so a typo in the name
# or a token pasted with a stray character was indistinguishable from working —
# right up until the day it mattered and your agent lost a contest it should
# have won.


def add_sara(box, *, tier: str = "elevated") -> str:
    """Add sara to the roster and return the token that was printed once."""
    done = box.ap("principals", "add", "sara", "--attended", tier)
    assert done.returncode == 0, done.stdout + done.stderr
    for line in done.stdout.splitlines():
        if line.strip().startswith("token"):
            return line.split()[-1]
    raise AssertionError(f"no token in:\n{done.stdout}")


def doctor_check(box, name: str, env: dict[str, str] | None = None) -> dict:
    done = box.ap("doctor", "--json", env=env)
    checks = json.loads(done.stdout)["checks"]
    found = [c for c in checks if c["name"] == name]
    assert found, f"no {name!r} check in {[c['name'] for c in checks]}"
    return found[0]


def test_doctor_says_so_when_this_machine_presents_nobody(box):
    check = doctor_check(box, "principal")
    assert check["state"] == "ok"
    assert "normal" in check["detail"]


def test_doctor_confirms_a_principal_whose_token_matches_the_roster(box):
    token = add_sara(box)
    env = box.env | {"AGENT_PRESENCE_PRINCIPAL": "sara",
                     "AGENT_PRESENCE_TOKEN": token}
    check = doctor_check(box, "principal", env)
    assert check["state"] == "ok"
    assert "sara" in check["detail"]
    assert "elevated" in check["detail"]


def test_doctor_reads_the_token_out_of_the_file_the_cli_told_you_to_write(box):
    token = add_sara(box)
    token_file = box.config / "agent-presence" / "token"
    token_file.parent.mkdir(parents=True, exist_ok=True)
    token_file.write_text(token + "\n")
    token_file.chmod(0o600)

    env = box.env | {"AGENT_PRESENCE_PRINCIPAL": "sara"}
    check = doctor_check(box, "principal", env)
    assert check["state"] == "ok"


def test_doctor_fails_a_principal_the_roster_has_never_heard_of(box):
    add_sara(box)
    env = box.env | {"AGENT_PRESENCE_PRINCIPAL": "sarah",  # one letter out
                     "AGENT_PRESENCE_TOKEN": "whatever"}
    check = doctor_check(box, "principal", env)
    assert check["state"] == "fail"
    assert "sarah" in check["detail"]


def test_doctor_fails_a_token_that_does_not_match_the_roster(box):
    add_sara(box)
    env = box.env | {"AGENT_PRESENCE_PRINCIPAL": "sara",
                     "AGENT_PRESENCE_TOKEN": "not-the-minted-one"}
    check = doctor_check(box, "principal", env)
    assert check["state"] == "fail"
    assert "does not match" in check["detail"]


def test_doctor_warns_when_a_principal_has_no_token_at_all(box):
    # Fail-open at the relay: this costs a tier, not a join. A warning, because
    # the machine still works and the person still is not getting what they
    # configured.
    add_sara(box)
    env = box.env | {"AGENT_PRESENCE_PRINCIPAL": "sara"}
    check = doctor_check(box, "principal", env)
    assert check["state"] == "warn"
    assert "no token" in check["detail"]


def test_doctor_warns_about_a_token_file_anyone_can_read(box):
    token = add_sara(box)
    token_file = box.config / "agent-presence" / "token"
    token_file.parent.mkdir(parents=True, exist_ok=True)
    token_file.write_text(token + "\n")
    token_file.chmod(0o644)

    env = box.env | {"AGENT_PRESENCE_PRINCIPAL": "sara"}
    check = doctor_check(box, "principal", env)
    assert check["state"] == "warn"
    assert "0644" in check["detail"]


def test_doctor_names_the_tier_the_unattended_bit_selects(box):
    done = box.ap("principals", "add", "sara", "--attended", "normal",
                  "--unattended", "critical")
    assert done.returncode == 0
    token = [ln.split()[-1] for ln in done.stdout.splitlines()
             if ln.strip().startswith("token")][0]

    env = box.env | {"AGENT_PRESENCE_PRINCIPAL": "sara",
                     "AGENT_PRESENCE_TOKEN": token,
                     "AGENT_PRESENCE_UNATTENDED": "1"}
    check = doctor_check(box, "principal", env)
    assert check["state"] == "ok"
    assert "critical" in check["detail"]
