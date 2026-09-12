import re

import pytest

from agent_sync.room_key import normalize_remote, room_id_from_remote

# The full ssh/https/.git/case/trailing-slash matrix from docs/design.md. Every
# one of these is the same repo, so every one of these has to be one room.
# `.git` and the trailing slash are independent: a remote can carry either,
# both, or neither, and `.git/` is the combination that used to split a team.
EQUIVALENT = [
    # scp/ssh short form
    "git@github.com:acme/api",
    "git@github.com:acme/api/",
    "git@github.com:acme/api.git",
    "git@github.com:acme/api.git/",
    # ssh:// long form
    "ssh://git@github.com/acme/api",
    "ssh://git@github.com/acme/api/",
    "ssh://git@github.com/acme/api.git",
    "ssh://git@github.com/acme/api.git/",
    # https
    "https://github.com/acme/api",
    "https://github.com/acme/api/",
    "https://github.com/acme/api.git",
    "https://github.com/acme/api.git/",
    # other protocols and host forms are discarded the same way
    "http://github.com/acme/api.git/",
    "git://github.com/acme/api.git/",
    "https://token@github.com/acme/api.git/",
    # case folds, including the suffix itself
    "HTTPS://GitHub.com/Acme/API.git",
    "HTTPS://GitHub.com/Acme/API.GIT/",
    "GIT@GITHUB.COM:ACME/API.GIT/",
    # surrounding whitespace is not part of the remote
    "  https://github.com/acme/api.git/ \n",
]


@pytest.mark.parametrize("url", EQUIVALENT)
def test_every_url_form_of_one_repo_collapses_to_one_key(url):
    assert normalize_remote(url) == "github.com/acme/api"


def test_the_whole_matrix_is_a_single_room():
    assert len({room_id_from_remote(u) for u in EQUIVALENT}) == 1


@pytest.mark.parametrize(
    "a,b",
    [
        ("git@github.com:acme/api.git", "git@github.com:acme/web.git"),
        ("git@github.com:acme/api.git", "git@gitlab.com:acme/api.git"),
        # Stripping a suffix must not merge repos that only look alike.
        ("https://github.com/acme/api.git/", "https://github.com/acme/apigit"),
        ("https://github.com/acme/api.git/", "https://github.com/acme/api.github"),
    ],
)
def test_distinct_repos_stay_distinct(a, b):
    assert normalize_remote(a) != normalize_remote(b)


def test_a_repo_whose_name_ends_in_git_keeps_its_name():
    # Only the ".git" suffix goes, and only once. "gitgit" is a repo name.
    assert normalize_remote("https://github.com/acme/gitgit/") == "github.com/acme/gitgit"


def test_room_id_is_stable_16_char_hex():
    rid = room_id_from_remote("git@github.com:acme/api.git")
    assert re.fullmatch(r"[0-9a-f]{16}", rid)
    assert room_id_from_remote("https://github.com/acme/api") == rid
    assert room_id_from_remote("https://github.com/acme/api.git/") == rid


def test_room_id_does_not_leak_the_repo_name():
    assert "secret" not in room_id_from_remote("git@github.com:acme/secret-project.git")
