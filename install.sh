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

# Every binary is attempted independently and a failure on one doesn't stop
# the others: a user missing only `go`, say, should still walk away with a
# working ap-hook, the settings JSON to paste in, and the mcp-add line for
# whatever did install, instead of a bare abort after the first miss. Status
# is tracked per binary and the script still exits non-zero if anything
# failed — it just does that last, after printing everything that's true.
mkdir -p "$BIN"
declare -a OK=() FAILED=()

# The hook stays C++ (see docs/gohook-spike.md) and still needs a cmake +
# C++20 build. The daemon is Go now (#18) and does not: `go build` alone
# produces a static binary, no OpenSSL, no CMake, no Catch2.
if [[ -x "$ROOT/cpp/build/ap-hook" ]]; then
  cp "$ROOT/cpp/build/ap-hook" "$BIN/ap-hook" && chmod +x "$BIN/ap-hook"
  OK+=(ap-hook)
else
  echo "missing $ROOT/cpp/build/ap-hook — build the hook first:" >&2
  echo "  cmake -S cpp -B cpp/build && cmake --build cpp/build" >&2
  FAILED+=(ap-hook)
  AP_HOOK_FAILED=1
fi

# presenced, agent-presence-mcp and gorelay: a release binary if one is
# already sitting next to this script (scripts/build-go-release.sh's
# output, or a binary pulled from a GitHub release built by
# .github/workflows/release.yml), otherwise a local `go build` — the whole
# point of #21 is that this is the only toolchain requirement left, no
# compiler or headers. gorelay is the relay itself (#40) — one operator
# runs it, everyone else's daemon just dials it, but it's built and
# installed here like the others rather than living behind a separate venv
# step now that there's no Python relay left to justify one.
#
# There is no download step here: on a machine with neither `dist/`
# populated nor a Go toolchain, this fails for good reason — see the
# message below and the README for what to do about it.
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
    cp "$release_bin" "$BIN/$name" && chmod +x "$BIN/$name"
    return
  fi
  if command -v go >/dev/null 2>&1; then
    ( cd "$ROOT/go" && CGO_ENABLED=0 go build -o "$BIN/$name" "./cmd/$name" ) && chmod +x "$BIN/$name"
    return
  fi
  echo "no $release_bin and no 'go' on PATH for $name — install Go, or" \
       "populate $RELEASE_DIR by downloading the binaries from a tagged" \
       "release and dropping them there (see README)" >&2
  return 1
}

for bin in presenced agent-presence-mcp gorelay; do
  if install_go_binary "$bin"; then OK+=("$bin"); else FAILED+=("$bin"); fi
done

echo "Installed: ${OK[*]:-none}"
if [[ "${#FAILED[@]}" -gt 0 ]]; then
  echo "Failed: ${FAILED[*]}" >&2
fi
echo "Binaries land in $BIN"
echo "Add this to ~/.claude/settings.json:"
if [[ "${AP_HOOK_FAILED:-0}" -eq 1 ]]; then
  # Adjacent to the JSON itself, not only in the "Failed:" line above — that
  # line scrolls out of view by the time someone's pasting this block, and a
  # settings.json pointing PreToolUse/PostToolUse at a binary that was never
  # installed makes every tool call invoke nothing.
  echo "WARNING: ap-hook failed to install (see above). The settings below" >&2
  echo "point at $BIN/ap-hook, which is not there. Build ap-hook and re-run" >&2
  echo "install.sh before using this." >&2
fi
settings_json
echo
echo "Then: claude mcp add agent-presence -- $BIN/agent-presence-mcp"

[[ "${#FAILED[@]}" -eq 0 ]]
