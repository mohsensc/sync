#!/usr/bin/env bash
# Installs the three agent-presence binaries: ap-hook, presenced,
# agent-presence-mcp. Prints Claude Code hook settings with
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

# presenced and agent-presence-mcp: fetched from a GitHub release for the
# running platform (#21) — no compiler, no CMake, no OpenSSL headers, just
# a download. Three ways a binary can land in $BIN, tried in order:
#   1. a release binary already sitting next to this script (dist/, either
#      scripts/build-go-release.sh's own output or something unpacked by
#      hand from a release download)
#   2. a real download of that same file from the repo's GitHub releases
#   3. `go build`, for a platform this repo hasn't cut a release for yet,
#      or when there's no network — the fallback #21 asks for, not the
#      normal path.
REPO="mohsensc/sync"
RELEASE_DIR="$ROOT/dist"
GOOS="$(uname -s | tr '[:upper:]' '[:lower:]')"
GOARCH="$(uname -m)"
case "$GOARCH" in
  x86_64) GOARCH=amd64 ;;
  arm64|aarch64) GOARCH=arm64 ;;
esac
# AGENT_PRESENCE_VERSION pins a tag (e.g. v0.1.0); unset fetches whatever
# the repo's "latest" release currently is.
RELEASE_TAG="${AGENT_PRESENCE_VERSION:-latest}"

# This repo is private, so a plain unauthenticated `curl` against
# github.com/.../releases/.../download/... 404s — GitHub only serves that
# redirect anonymously for a public repo. `gh` (already this repo's own
# tool of choice, and a reasonable thing for anyone spreading this inside a
# company to already have) hits the authenticated API instead. A bare curl
# is still tried after, for the day this repo is public or a GITHUB_TOKEN
# is already in the environment — it costs nothing to try.
# No arrays for the optional bits below: macOS still ships bash 3.2 as
# /bin/bash, and `"${arr[@]}"` on an empty array trips `set -u` there
# (fixed in 4.4) even though it's fine everywhere else this runs.
fetch_release_binary() {
  local name="$1" dest="$2" asset="$name-$GOOS-$GOARCH"

  if command -v gh >/dev/null 2>&1 && gh auth status >/dev/null 2>&1; then
    if [[ "$RELEASE_TAG" == "latest" ]]; then
      gh release download --repo "$REPO" --pattern "$asset" \
        --output "$dest" --clobber >/dev/null 2>&1 && return 0
    else
      gh release download "$RELEASE_TAG" --repo "$REPO" --pattern "$asset" \
        --output "$dest" --clobber >/dev/null 2>&1 && return 0
    fi
  fi

  command -v curl >/dev/null 2>&1 || return 1
  local url
  if [[ "$RELEASE_TAG" == "latest" ]]; then
    url="https://github.com/$REPO/releases/latest/download/$asset"
  else
    url="https://github.com/$REPO/releases/download/$RELEASE_TAG/$asset"
  fi
  local tmp
  tmp="$(mktemp)"
  local ok=1
  if [[ -n "${GITHUB_TOKEN:-}" ]]; then
    curl -fsSL -H "Authorization: Bearer $GITHUB_TOKEN" "$url" -o "$tmp" 2>/dev/null && ok=0
  else
    curl -fsSL "$url" -o "$tmp" 2>/dev/null && ok=0
  fi
  if [[ "$ok" == 0 ]]; then
    mv "$tmp" "$dest"
    return 0
  fi
  rm -f "$tmp"
  return 1
}

install_go_binary() {
  local name="$1" release_bin="$RELEASE_DIR/$1-$GOOS-$GOARCH" dest="$BIN/$1"
  if [[ -x "$release_bin" ]]; then
    cp "$release_bin" "$dest"
  elif fetch_release_binary "$name" "$dest"; then
    echo "fetched $name $RELEASE_TAG for $GOOS/$GOARCH from $REPO"
  elif command -v go >/dev/null 2>&1; then
    echo "no release binary for $GOOS/$GOARCH ($name $RELEASE_TAG) — building locally" >&2
    ( cd "$ROOT/go" && CGO_ENABLED=0 go build -o "$dest" "./cmd/$name" )
  else
    echo "no release binary for $GOOS/$GOARCH and no 'go' on PATH — install Go, or set AGENT_PRESENCE_VERSION to a released tag that covers this platform" >&2
    exit 1
  fi
  chmod +x "$dest"
}

install_go_binary presenced
install_go_binary agent-presence-mcp

echo "Binaries installed to $BIN"
echo "Add this to ~/.claude/settings.json:"
settings_json
echo
echo "Then: claude mcp add agent-presence -- $BIN/agent-presence-mcp"
