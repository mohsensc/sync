import json
import pathlib
import subprocess

ROOT = pathlib.Path(__file__).resolve().parents[2]


def test_install_script_emits_valid_settings_json():
    out = subprocess.run(
        ["bash", str(ROOT / "install.sh"), "--print-settings"],
        capture_output=True, text=True, check=True,
    ).stdout
    settings = json.loads(out)
    hooks = settings["hooks"]
    assert "PreToolUse" in hooks
    assert "PostToolUse" in hooks


def test_hooks_cover_every_tool_that_touches_code():
    out = subprocess.run(
        ["bash", str(ROOT / "install.sh"), "--print-settings"],
        capture_output=True, text=True, check=True,
    ).stdout
    matchers = json.dumps(json.loads(out)["hooks"])
    for tool in ("Edit", "Write", "Read", "Grep"):
        assert tool in matchers
