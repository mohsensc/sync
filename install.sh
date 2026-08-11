#!/usr/bin/env bash
# Installs the agent-presence binaries: ap-hook, presenced,
# agent-presence-mcp, gorelay. Prints Claude Code hook settings with
# --print-settings.
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

# presenced, agent-presence-mcp and gorelay: a release binary if one is
# already sitting next to this script (scripts/build-go-release.sh's
# output, or something CI attached to a tag), otherwise a local `go build`
# — the whole point of #21 is that this is the only toolchain requirement
# left, no compiler or headers. gorelay is the relay itself (#40) — one
# operator runs it, everyone else's daemon just dials it, but it's built
# and installed here like the others rather than living behind a separate
# venv step now that there's no Python relay left to justify one.
RELEASE_DIR="$ROOT/dist"
GOOS="$(uname -s | tr '[:upper:]' '[:lower:]')"
GOARCH="$(uname -m)"
case "$GOARCH" in
  x86_64) GOARCH=amd64 ;;
  arm64|aarch64) GOARCH=arm64 ;;
esac

install_go_binary() {
  local name="$1" release_bin="$RELEASE_DIR/$1-$GOOS-$GOARCH"
  if [[ -x "$release_bin" ]]; then
    cp "$release_bin" "$BIN/$name"
  elif command -v go >/dev/null 2>&1; then
    ( cd "$ROOT/go" && CGO_ENABLED=0 go build -o "$BIN/$name" "./cmd/$name" )
  else
    echo "no $release_bin and no 'go' on PATH — install Go or fetch a release binary into $RELEASE_DIR" >&2
    exit 1
  fi
  chmod +x "$BIN/$name"
}

install_go_binary presenced
install_go_binary agent-presence-mcp
install_go_binary gorelay

echo "Binaries installed to $BIN"
echo "Add this to ~/.claude/settings.json:"
settings_json
echo
echo "Then: claude mcp add agent-presence -- $BIN/agent-presence-mcp"
