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

# The hook stays C++ (see docs/gohook-spike.md) and still needs a cmake +
# C++20 build. The daemon is Go now (#18) and does not: `go build` alone
# produces a static binary, no OpenSSL, no CMake, no Catch2.
if [[ ! -x "$ROOT/cpp/build/ap-hook" ]]; then
  echo "missing $ROOT/cpp/build/ap-hook — build the hook first:" >&2
  echo "  cmake -S cpp -B cpp/build && cmake --build cpp/build" >&2
  exit 1
fi

mkdir -p "$BIN"
cp "$ROOT/cpp/build/ap-hook" "$BIN/ap-hook"
chmod +x "$BIN/ap-hook"

# presenced: a release binary if one is already sitting next to this script
# (scripts/build-go-release.sh's output, or something CI attached to a tag),
# otherwise a local `go build` — the whole point of #21 is that this is the
# only toolchain requirement left, no compiler or headers.
RELEASE_DIR="$ROOT/dist"
GOOS="$(uname -s | tr '[:upper:]' '[:lower:]')"
GOARCH="$(uname -m)"
case "$GOARCH" in
  x86_64) GOARCH=amd64 ;;
  arm64|aarch64) GOARCH=arm64 ;;
esac
RELEASE_BIN="$RELEASE_DIR/presenced-$GOOS-$GOARCH"

if [[ -x "$RELEASE_BIN" ]]; then
  cp "$RELEASE_BIN" "$BIN/presenced"
elif command -v go >/dev/null 2>&1; then
  ( cd "$ROOT/go" && CGO_ENABLED=0 go build -o "$BIN/presenced" ./cmd/presenced )
else
  echo "no $RELEASE_BIN and no 'go' on PATH — install Go or fetch a release binary into $RELEASE_DIR" >&2
  exit 1
fi
chmod +x "$BIN/presenced"

echo "Binaries installed to $BIN"
echo "Add this to ~/.claude/settings.json:"
settings_json
