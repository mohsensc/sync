"""Room, agent and human are derived, not configured.

That's the whole install story — clone the repo and you're in the right room —
so it gets tested against real `git` repos on disk rather than mocks.
"""

from __future__ import annotations

import os
import subprocess

import pytest

from agent_presence.mcp_server import (
    Tools,
    agent_id,
    build_tools,
    git_remote,
    human_id,
    repo_root,
    room_for,
)
from agent_presence.room_key import room_id_from_remote


@pytest.fixture(autouse=True)
def _no_overrides(monkeypatch):
    for var in ("AGENT_PRESENCE_ROOM", "AGENT_PRESENCE_AGENT",
                "AGENT_PRESENCE_HUMAN", "CLAUDE_CODE_SESSION_ID",
                "CLAUDE_SESSION_ID"):
        monkeypatch.delenv(var, raising=False)


def _git(cwd, *args):
    subprocess.run(("git", *args), cwd=cwd, check=True, capture_output=True)


@pytest.fixture
def repo(tmp_path):
    root = tmp_path / "work" / "api"
    root.mkdir(parents=True)
    _git(root, "init", "-q")
    _git(root, "config", "user.email", "sara@acme.example")
    _git(root, "config", "user.name", "Sara")
    _git(root, "remote", "add", "origin", "git@github.com:acme/api.git")
    return root


@pytest.fixture
def bare_repo(tmp_path):
    """A repo with no remote. Local-only mode."""
    root = tmp_path / "solo"
    root.mkdir()
    _git(root, "init", "-q")
    _git(root, "config", "user.email", "dev@acme.example")
    return root


# -- room -------------------------------------------------------------------


def test_room_is_the_hash_of_the_git_remote(repo):
    assert room_for(str(repo)) == room_id_from_remote("git@github.com:acme/api.git")


def test_two_clones_of_one_repo_land_in_the_same_room(tmp_path, repo):
    other = tmp_path / "elsewhere" / "api"
    other.mkdir(parents=True)
    _git(other, "init", "-q")
    # Same repo, the https form. Normalization is what makes these one room.
    _git(other, "remote", "add", "origin", "https://github.com/acme/api")
    assert room_for(str(other)) == room_for(str(repo))


def test_a_subdirectory_of_the_repo_gets_the_same_room(repo):
    sub = repo / "src" / "deep"
    sub.mkdir(parents=True)
    assert room_for(str(sub)) == room_for(str(repo))


def test_a_repo_with_no_remote_falls_back_to_a_local_room(bare_repo):
    room = room_for(str(bare_repo))
    assert room.startswith("local-")
    assert room != room_for(str(bare_repo.parent))


def test_a_remote_that_is_not_origin_still_keys_the_room(tmp_path):
    root = tmp_path / "forked"
    root.mkdir()
    _git(root, "init", "-q")
    _git(root, "remote", "add", "upstream", "https://github.com/acme/api.git")
    assert room_for(str(root)) == room_id_from_remote("https://github.com/acme/api")


def test_the_room_env_var_overrides_the_git_remote(repo, monkeypatch):
    monkeypatch.setenv("AGENT_PRESENCE_ROOM", "r1")
    assert room_for(str(repo)) == "r1"


def test_a_directory_outside_any_repo_still_gets_a_room(tmp_path):
    outside = tmp_path / "not-a-repo"
    outside.mkdir()
    assert room_for(str(outside)).startswith("local-")


# -- repo discovery ---------------------------------------------------------


def test_repo_root_walks_up_from_a_subdirectory(repo):
    sub = repo / "a" / "b"
    sub.mkdir(parents=True)
    assert os.path.realpath(repo_root(str(sub))) == os.path.realpath(str(repo))


def test_git_remote_is_none_when_there_is_no_remote(bare_repo):
    assert git_remote(str(bare_repo)) is None


# -- human ------------------------------------------------------------------


def test_human_comes_from_git_config_user_email(repo):
    assert human_id(str(repo)) == "sara"


def test_the_domain_never_leaves_the_machine(repo):
    assert "acme.example" not in human_id(str(repo))
    assert "@" not in human_id(str(repo))


def test_human_falls_back_when_git_has_no_email(tmp_path, monkeypatch):
    plain = tmp_path / "plain"
    plain.mkdir()
    monkeypatch.setenv("USER", "someone-else")
    monkeypatch.setenv("HOME", str(tmp_path))  # keep global git config out
    monkeypatch.setenv("GIT_CONFIG_GLOBAL", str(tmp_path / "nonexistent"))
    monkeypatch.setenv("GIT_CONFIG_SYSTEM", str(tmp_path / "nonexistent"))
    assert human_id(str(plain)) == "someone-else"


def test_the_human_env_var_wins(repo, monkeypatch):
    monkeypatch.setenv("AGENT_PRESENCE_HUMAN", "pinned")
    assert human_id(str(repo)) == "pinned"


# -- agent ------------------------------------------------------------------


def test_agent_uses_the_claude_code_session_id(monkeypatch):
    monkeypatch.setenv("CLAUDE_CODE_SESSION_ID", "sess_abc")
    assert agent_id() == "sess_abc"


def test_agent_env_var_beats_the_session_id(monkeypatch):
    monkeypatch.setenv("CLAUDE_CODE_SESSION_ID", "sess_abc")
    monkeypatch.setenv("AGENT_PRESENCE_AGENT", "pinned")
    assert agent_id() == "pinned"


def test_agent_is_generated_and_unique_when_nothing_declares_one():
    assert agent_id() != agent_id()
    assert agent_id().startswith("sess_")


# -- assembly ---------------------------------------------------------------


def test_build_tools_wires_all_three_from_the_repo(repo, monkeypatch):
    monkeypatch.setenv("CLAUDE_CODE_SESSION_ID", "sess_abc")
    tools = build_tools(str(repo))
    assert isinstance(tools, Tools)
    assert tools.room == room_id_from_remote("git@github.com:acme/api.git")
    assert tools.agent == "sess_abc"
    assert tools.human == "sara"


def test_build_tools_produces_a_working_tool_surface(repo):
    tools = build_tools(str(repo))
    assert tools.who_else_is_here() == []
    assert tools.claim_work("src/db.py", "query", "add index")["granted"]
    # The second claim from a different session must be refused, which only
    # works if build_tools gave the registry a real room and agent.
    other = build_tools(str(repo), relay=tools._relay)
    refused = other.claim_work("src/db.py", "query", "add index")
    assert not refused["granted"]
    assert refused["held_by"] == tools.agent


def test_identity_is_read_only_once_tools_exist(repo):
    tools = build_tools(str(repo))
    with pytest.raises(AttributeError):
        tools.agent = "someone-elses-session"
