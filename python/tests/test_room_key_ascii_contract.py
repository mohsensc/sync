"""The room key is a cross-language contract.

The same vectors are hardcoded in cpp/tests/test_repo.cpp. If one side changes
its idea of "lowercase" or "whitespace", one of these two suites breaks instead
of a team silently splitting into two rooms.
"""

from agent_sync.room_key import normalize_remote, room_id_from_remote

# url -> (normalized, room id)
VECTORS = {
    "git@github.com:acme/api.git": ("github.com/acme/api", "e1dcaa3496b93562"),
    "https://github.com/acme/api": ("github.com/acme/api", "e1dcaa3496b93562"),
    "https://github.com/acme/api.git": ("github.com/acme/api", "e1dcaa3496b93562"),
    "ssh://git@github.com/acme/api.git": ("github.com/acme/api", "e1dcaa3496b93562"),
    "HTTPS://GitHub.com/Acme/API.git": ("github.com/acme/api", "e1dcaa3496b93562"),
    "https://github.com/acme/api/": ("github.com/acme/api", "e1dcaa3496b93562"),
    "  https://github.com/acme/api.git \n": ("github.com/acme/api", "e1dcaa3496b93562"),
    "https://github.com/acme/api.git\x1d": ("github.com/acme/api", "e1dcaa3496b93562"),
    "https://github.com/acme/\u00dcnicode-Repo.git": (
        "github.com/acme/\u00dcnicode-repo",
        "2707d06139ada0c0",
    ),
    "git@gitlab.com:\u00c9QUIPE/Projet.git": (
        "gitlab.com/\u00c9quipe/projet",
        "fbcc8d6b93e2a37f",
    ),
    "\u00a0https://github.com/acme/api.git\u00a0": (
        "\u00a0https://github.com/acme/api.git\u00a0",
        "a2204ca2a2dbc8dc",
    ),
    "git@host:pa\rth": ("host/pa\rth", "cab7f1fc89970e3a"),
    "git@github.com:acme/web.git": ("github.com/acme/web", "6622211c92d781b7"),
    "git@gitlab.com:acme/api.git": ("gitlab.com/acme/api", "1055cc0317804d28"),
}


def test_vectors_match_the_cpp_daemon():
    got = {u: (normalize_remote(u), room_id_from_remote(u)) for u in VECTORS}
    assert got == VECTORS


def test_case_folding_and_trimming_are_ascii_only():
    # C++ has no unicode case mapping in the standard library, so neither side
    # is allowed to fold non-ascii. Same for whitespace: U+00A0 stays.
    assert normalize_remote("\u00dc") == "\u00dc"
    assert normalize_remote("\u0130") == "\u0130"
    assert normalize_remote("\u00a0x\u00a0") == "\u00a0x\u00a0"
    assert normalize_remote("\u2028x\u2028") == "\u2028x\u2028"
    # ...and every ascii character str.strip() would remove is still removed.
    for ch in "\t\n\x0b\x0c\r\x1c\x1d\x1e\x1f ":
        assert normalize_remote(f"{ch}x{ch}") == "x"
