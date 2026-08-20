"""Direct tests for `atomic_write`, the temp-file-then-rename seam shared by
policy edits and `ap principals add`.

`ap policy set` / `unset` round trips are exercised through the CLI in
test_cli.py, which proves the function works end to end but can't reach the
one thing that actually matters here: what a reader sees if the process
dies between the write and the rename. That's only reachable in-process,
by making the rename itself fail.
"""

from __future__ import annotations

import os

import pytest

from agent_presence import policy_edit


def test_atomic_write_creates_a_new_file_with_the_default_mode(tmp_path):
    target = tmp_path / "sub" / "file.toml"
    policy_edit.atomic_write(target, "hello\n")
    assert target.read_text() == "hello\n"
    assert (target.stat().st_mode & 0o777) == 0o644
    # No temp file left behind on the happy path.
    assert not target.with_name(target.name + ".tmp").exists()


def test_atomic_write_preserves_an_existing_files_mode(tmp_path):
    target = tmp_path / "file.toml"
    target.write_text("old\n")
    target.chmod(0o640)
    policy_edit.atomic_write(target, "new\n")
    assert target.read_text() == "new\n"
    assert (target.stat().st_mode & 0o777) == 0o640


def test_a_failure_before_rename_never_shows_a_torn_file(tmp_path, monkeypatch):
    """The seam that's actually testable: os.replace is the single atomic
    step. Fail right before it fires and prove the target still holds the
    old bytes whole -- not new bytes, not a half-written mix. That's the
    same guarantee that keeps a crash mid `principals add` from handing
    Roster.parse a torn TOML file."""
    target = tmp_path / "file.toml"
    target.write_text("old and complete\n")

    def boom(*_a, **_kw):
        raise OSError("simulated crash between write and rename")

    monkeypatch.setattr(os, "replace", boom)
    with pytest.raises(OSError):
        policy_edit.atomic_write(target, "new content that must never land\n")

    assert target.read_text() == "old and complete\n"


def test_a_successful_write_lands_the_new_content_whole(tmp_path):
    target = tmp_path / "file.toml"
    target.write_text("old\n")
    policy_edit.atomic_write(target, "brand new content\n")
    assert target.read_text() == "brand new content\n"
