#!/usr/bin/env bash
# Installs agent-presence hooks. Prints settings with --print-settings.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BIN="${AGENT_PRESENCE_BIN:-$HOME/.local/bin}"

settings_json() {
  cat <<JSON
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "Edit|Write|NotebookEdit",
        "hooks": [{ "type": "command", "command": "$BIN/ap-hook" }]
      }
    ],
    "PostToolUse": [
      {
        "matcher": "Read|Grep|Glob|Bash",
        "hooks": [{ "type": "command", "command": "$BIN/ap-hook" }]
      }
    ]
  }
}
JSON
}

if [[ "${1:-}" == "--print-settings" ]]; then
  settings_json
  exit 0
fi

for b in ap-hook presenced; do
  if [[ ! -x "$ROOT/cpp/build/$b" ]]; then
    echo "missing $ROOT/cpp/build/$b — build first:" >&2
    echo "  cmake -S cpp -B cpp/build && cmake --build cpp/build" >&2
    exit 1
  fi
done

mkdir -p "$BIN"
cp "$ROOT/cpp/build/ap-hook" "$BIN/ap-hook"
cp "$ROOT/cpp/build/presenced" "$BIN/presenced"
chmod +x "$BIN/ap-hook" "$BIN/presenced"

echo "Binaries installed to $BIN"
echo "Add this to ~/.claude/settings.json:"
settings_json
