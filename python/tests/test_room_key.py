import re

import pytest

from agent_presence.room_key import normalize_remote, room_id_from_remote

EQUIVALENT = [
    "git@github.com:acme/api.git",
    "https://github.com/acme/api",
    "https://github.com/acme/api.git",
    "ssh://git@github.com/acme/api.git",
    "HTTPS://GitHub.com/Acme/API.git",
    "https://github.com/acme/api/",
]


def test_every_url_form_of_one_repo_collapses_to_one_key():
    keys = {normalize_remote(u) for u in EQUIVALENT}
    assert keys == {"github.com/acme/api"}


@pytest.mark.parametrize(
    "a,b",
    [
        ("git@github.com:acme/api.git", "git@github.com:acme/web.git"),
        ("git@github.com:acme/api.git", "git@gitlab.com:acme/api.git"),
    ],
)
def test_distinct_repos_stay_distinct(a, b):
    assert normalize_remote(a) != normalize_remote(b)


def test_room_id_is_stable_16_char_hex():
    rid = room_id_from_remote("git@github.com:acme/api.git")
    assert re.fullmatch(r"[0-9a-f]{16}", rid)
    assert room_id_from_remote("https://github.com/acme/api") == rid


def test_room_id_does_not_leak_the_repo_name():
    assert "secret" not in room_id_from_remote("git@github.com:acme/secret-project.git")
