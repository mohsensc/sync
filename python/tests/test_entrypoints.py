"""The launchable surface: `python -m` and the console scripts.

These all start real processes. Importing a module proves nothing about
whether it runs.

The relay used to be covered here too — `python -m agent_presence.serve`
and the `agent-presence-relay` console script, spawned and checked for a
real bound socket and a real reply. It's `go/cmd/gorelay` now, the only
relay (#40): `go/internal/relay/gorelay_integration_test.go` builds and
runs the real binary the same way this file did, for the same claim (it
starts, binds, and answers a real client over the wire), and
`python/tests/helpers/gorelay_proc.py` is what the black-box suite
(test_e2e.py, test_serve.py, test_relay_restart.py) spawns it through for
everything past "does it start."
"""

from __future__ import annotations

import subprocess
import sys
import tomllib
from importlib import import_module
from pathlib import Path

import pytest

PYTHON_ROOT = Path(__file__).resolve().parents[1]
PYPROJECT = PYTHON_ROOT / "pyproject.toml"
BIN_DIR = Path(sys.executable).parent

# Generous: a cold subprocess import is not fast.
BOOT_TIMEOUT_S = 30.0


def _clean_env(**extra: str) -> dict[str, str]:
    import os
    env = {k: v for k, v in os.environ.items()
           if not k.startswith("AGENT_PRESENCE_")}
    env.update(extra)
    return env


# -- the console scripts ----------------------------------------------------
#
# agent-presence-mcp used to be a console script here too, checked the same
# way `ap` is below. It's a Go binary now (#32) — go/cmd/agent-presence-mcp
# has its own build-and-exec tests for the same claims (starts, speaks the
# protocol, exits cleanly). agent-presence-relay is gone the same way, for
# the same reason: see the module docstring.

EXPECTED_SCRIPTS = {
    "ap": "agent_presence.cli:main",
}


def test_pyproject_declares_every_console_script():
    scripts = tomllib.loads(PYPROJECT.read_text())["project"]["scripts"]
    assert scripts == EXPECTED_SCRIPTS


@pytest.mark.parametrize("target", sorted(EXPECTED_SCRIPTS.values()))
def test_each_console_script_target_resolves_to_a_callable(target):
    module_name, _, attr = target.partition(":")
    entry = getattr(import_module(module_name), attr)
    assert callable(entry)


@pytest.mark.parametrize("name", sorted(EXPECTED_SCRIPTS))
def test_the_installed_console_script_runs(name):
    script = BIN_DIR / name
    assert script.exists(), (
        f"{script} is missing — reinstall with `pip install -e '.[dev]'`"
    )
    proc = subprocess.run([str(script), "--help"], capture_output=True,
                          text=True, timeout=BOOT_TIMEOUT_S, env=_clean_env())
    assert proc.returncode == 0, proc.stderr
    assert name in proc.stdout
