"""Guards against preflight() reaching for a port again.

`pytest`'s `testpaths` is `python/tests` (see python/pyproject.toml), so this
file is not collected by a bare `python -m pytest` from python/ — it lives
next to the harness it tests instead, and is meant to be run directly:

    .ci-local/venv312/bin/python tests/load/test_preflight.py

(any interpreter with `websockets` on it works — `run.py` imports
`scenarios`, which needs it, just to reach `preflight` at all.)

preflight() used to run `lsof -ti:8799 | xargs kill -9` unconditionally,
system-wide, with no check that whatever was listening on 8799 belonged to
this harness. Nothing in the current harness binds that port — `free_port()`
in `_lib.py` already avoids the collision it was guarding against — so the
kill was pure blast radius: on a shared machine it could take out a
teammate's or another agent's unrelated process. This asserts the fix by
construction: no command preflight() runs may mention `kill` at all.
"""

from __future__ import annotations

import sys
import unittest
from pathlib import Path
from unittest import mock

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))

import run  # noqa: E402


class PreflightDoesNotKillAnything(unittest.TestCase):
    def test_no_command_mentions_kill(self):
        commands = []

        def fake_run(cmd, *args, **kwargs):
            commands.append(cmd)
            return mock.Mock(returncode=0)

        with mock.patch.object(run, "AP_HOOK") as ap_hook, \
             mock.patch.object(run.subprocess, "run", side_effect=fake_run), \
             mock.patch.object(run, "build_presenced"), \
             mock.patch.object(run, "build_gorelay"), \
             mock.patch.object(run, "build_hookbench"):
            ap_hook.exists.return_value = True
            run.preflight()

        def mentions_kill(cmd):
            text = " ".join(cmd) if isinstance(cmd, (list, tuple)) else str(cmd)
            return "kill" in text

        offenders = [c for c in commands if mentions_kill(c)]
        self.assertEqual(
            offenders, [],
            f"preflight() ran a command mentioning 'kill': {offenders}")


if __name__ == "__main__":
    unittest.main()
