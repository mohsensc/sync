#!/usr/bin/env bash
# Exercises install.sh's partial-failure behaviour (section 3 of the ops
# audit): a missing/unbuildable binary must not swallow the settings JSON
# and next-steps text the other, working binaries still need.
#
# Runs install.sh against a throwaway fake repo tree, not this checkout —
# ROOT is derived from install.sh's own path, so faking `go/cmd/gorelay`
# here means never touching the real one, which matters since five other
# agents are building against it right now.
#
#   scripts/test-install.sh
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
INSTALL_SH="${1:-$HERE/../install.sh}"

FAILS=0
assert() {
  local desc="$1" got="$2" want="$3"
  if [[ "$got" == "$want" ]]; then
    printf '  ok    %s\n' "$desc"
  else
    printf '  FAIL  %s (got %q, want %q)\n' "$desc" "$got" "$want"
    FAILS=$((FAILS + 1))
  fi
}

assert_contains() {
  local desc="$1" haystack="$2" needle="$3"
  if [[ "$haystack" == *"$needle"* ]]; then
    printf '  ok    %s\n' "$desc"
  else
    printf '  FAIL  %s (missing %q)\n' "$desc" "$needle"
    FAILS=$((FAILS + 1))
  fi
}

assert_not_contains() {
  local desc="$1" haystack="$2" needle="$3"
  if [[ "$haystack" != *"$needle"* ]]; then
    printf '  ok    %s\n' "$desc"
  else
    printf '  FAIL  %s (unexpectedly found %q)\n' "$desc" "$needle"
    FAILS=$((FAILS + 1))
  fi
}

# fake_root <dir> <good|broken|nohook> — a minimal ROOT with a prebuilt
# ap-hook stub and a go module with three cmd/ packages. "broken" makes
# gorelay's source fail to compile, standing in for "the toolchain is here
# but one binary won't build". "nohook" omits the ap-hook stub entirely,
# standing in for "the hook was never built" — the case the settings-JSON
# warning in install.sh exists for.
fake_root() {
  local dir="$1" mode="$2"
  mkdir -p "$dir/cpp/build" "$dir/go/cmd/presenced" "$dir/go/cmd/agent-presence-mcp" "$dir/go/cmd/gorelay"
  cp "$INSTALL_SH" "$dir/install.sh"
  chmod +x "$dir/install.sh"
  if [[ "$mode" != "nohook" ]]; then
    printf '#!/bin/sh\necho hook-stub\n' > "$dir/cpp/build/ap-hook"
    chmod +x "$dir/cpp/build/ap-hook"
  fi
  cat > "$dir/go/go.mod" <<'EOF'
module fakeinstall

go 1.22
EOF
  for pkg in presenced agent-presence-mcp; do
    cat > "$dir/go/cmd/$pkg/main.go" <<'EOF'
package main

func main() {}
EOF
  done
  if [[ "$mode" == "broken" ]]; then
    # a syntax error, not just a nonzero exit — this is what "won't build"
    # actually looks like from install.sh's side.
    printf 'package main\n\nfunc main() {\n' > "$dir/go/cmd/gorelay/main.go"
  else
    printf 'package main\n\nfunc main() {}\n' > "$dir/go/cmd/gorelay/main.go"
  fi
}

echo "=== happy path: all four binaries buildable ==="
HAPPY_ROOT="$(mktemp -d)"
HAPPY_BIN="$(mktemp -d)"
# Declared before the trap that names them: under `set -u`, a trap firing
# between here and the BROKEN_*/NOHOOK_* assignments below (any early exit)
# would otherwise hit an unbound variable and skip cleanup entirely instead
# of just cleaning up less.
BROKEN_ROOT=""
BROKEN_BIN=""
NOHOOK_ROOT=""
NOHOOK_BIN=""
STALE_ROOT=""
STALE_BIN=""
STALE_NOGO_ROOT=""
STALE_NOGO_BIN=""
NOGO_SHIM=""
trap 'rm -rf "$HAPPY_ROOT" "$HAPPY_BIN" "$BROKEN_ROOT" "$BROKEN_BIN" "$NOHOOK_ROOT" "$NOHOOK_BIN" "$STALE_ROOT" "$STALE_BIN" "$STALE_NOGO_ROOT" "$STALE_NOGO_BIN" "$NOGO_SHIM"' EXIT
fake_root "$HAPPY_ROOT" good
OUT="$(AGENT_PRESENCE_BIN="$HAPPY_BIN" bash "$HAPPY_ROOT/install.sh" 2>&1)"
RC=$?
assert "exits 0" "$RC" "0"
for b in ap-hook presenced agent-presence-mcp gorelay; do
  assert "$b installed and executable" \
    "$([[ -x "$HAPPY_BIN/$b" ]] && echo yes || echo no)" "yes"
done
assert_contains "prints settings JSON" "$OUT" '"PreToolUse"'
assert_contains "prints mcp add line" "$OUT" "claude mcp add agent-presence"
assert_not_contains "no ap-hook warning when ap-hook installed cleanly" "$OUT" \
  "WARNING: ap-hook"

echo "=== partial failure: gorelay won't build ==="
BROKEN_ROOT="$(mktemp -d)"
BROKEN_BIN="$(mktemp -d)"
fake_root "$BROKEN_ROOT" broken
OUT="$(AGENT_PRESENCE_BIN="$BROKEN_BIN" bash "$BROKEN_ROOT/install.sh" 2>&1)"
RC=$?
# Direct value comparisons throughout, not "assert the previous command's
# $? equals some expected-to-fail value" — that pattern reads as asserting
# the assertion itself failed, and inverts silently if this file is ever
# edited without noticing which way the logic runs.
assert "exits non-zero" "$([[ "$RC" -ne 0 ]] && echo yes || echo no)" "yes"
for b in ap-hook presenced agent-presence-mcp; do
  assert "$b still installed despite gorelay failing" \
    "$([[ -x "$BROKEN_BIN/$b" ]] && echo yes || echo no)" "yes"
done
assert "gorelay correctly absent" \
  "$([[ -e "$BROKEN_BIN/gorelay" ]] && echo present || echo absent)" "absent"
assert_contains "still prints settings JSON on partial failure" "$OUT" '"PreToolUse"'
assert_contains "still prints mcp add line on partial failure" "$OUT" "claude mcp add agent-presence"
assert_contains "reports gorelay by name as failed" "$OUT" "gorelay"

echo "=== partial failure: ap-hook missing ==="
NOHOOK_ROOT="$(mktemp -d)"
NOHOOK_BIN="$(mktemp -d)"
fake_root "$NOHOOK_ROOT" nohook
OUT="$(AGENT_PRESENCE_BIN="$NOHOOK_BIN" bash "$NOHOOK_ROOT/install.sh" 2>&1)"
RC=$?
assert "exits non-zero" "$([[ "$RC" -ne 0 ]] && echo yes || echo no)" "yes"
for b in presenced agent-presence-mcp gorelay; do
  assert "$b still installed despite ap-hook missing" \
    "$([[ -x "$NOHOOK_BIN/$b" ]] && echo yes || echo no)" "yes"
done
assert "ap-hook correctly absent" \
  "$([[ -e "$NOHOOK_BIN/ap-hook" ]] && echo present || echo absent)" "absent"
assert_contains "still prints settings JSON on partial failure" "$OUT" '"PreToolUse"'
# The regression this guards: settings JSON pointing PreToolUse/PostToolUse
# at a binary that never installed, with the only warning stuck in a
# summary line the reader has already scrolled past.
assert_contains "warns ap-hook is missing, next to the settings JSON" "$OUT" \
  "WARNING: ap-hook failed to install"

# stale_dist_root <dir> — a "good" fake_root plus a dist/gorelay stub
# that's older than go/cmd/gorelay/main.go and a dist/presenced stub
# that's newer, standing in for #96: dist/ built once, then a source edit
# nobody rebuilt for, alongside a binary nothing touched since. presenced
# stays fresh so "installing prebuilt" gets covered in the same run;
# agent-presence-mcp is left with no dist/ entry at all, same as
# fake_root's other modes, so all three log lines this fix adds show up
# from one install.sh invocation.
GOOS="$(uname -s | tr '[:upper:]' '[:lower:]')"
GOARCH="$(uname -m)"
case "$GOARCH" in
  x86_64) GOARCH=amd64 ;;
  arm64|aarch64) GOARCH=arm64 ;;
esac
GORELAY_DIST="gorelay-$GOOS-$GOARCH"
PRESENCED_DIST="presenced-$GOOS-$GOARCH"

stale_dist_root() {
  local dir="$1"
  fake_root "$dir" good
  mkdir -p "$dir/dist"
  printf '#!/bin/sh\necho stale-stub\n' > "$dir/dist/$GORELAY_DIST"
  chmod +x "$dir/dist/$GORELAY_DIST"
  printf '#!/bin/sh\necho fresh-stub\n' > "$dir/dist/$PRESENCED_DIST"
  chmod +x "$dir/dist/$PRESENCED_DIST"
  # Backdate the gorelay stub, then touch its source strictly after it —
  # mtime ordering is what install.sh's stale_source() actually checks.
  # Postdate the presenced stub instead, since its source (from fake_root)
  # was already written at "now": no source file will ever be newer.
  touch -t 202001010000 "$dir/dist/$GORELAY_DIST"
  touch -t 203001010000 "$dir/dist/$PRESENCED_DIST"
  touch "$dir/go/cmd/gorelay/main.go"
}

# nogo_path <dir> — symlinks only the coreutils install.sh and this
# fixture need into <dir>, resolved from the real PATH rather than
# guessed at a fixed location. A distro-packaged go can sit at /usr/bin/go
# (Debian, Fedora), so hardcoding something like PATH=/usr/bin:/bin would
# put go right back on the path this case is specifically about not
# having; symlinking named tools can't accidentally pull go in with them.
nogo_path() {
  local dir="$1" t p
  mkdir -p "$dir"
  # printf is a bash builtin, so `command -v` returns a bare name, not a
  # path — nothing to symlink, and the shimmed bash below has the same
  # builtin anyway.
  for t in bash cp chmod mkdir cat dirname uname tr find; do
    p="$(command -v "$t")" && [[ "$p" == /* ]] && ln -sf "$p" "$dir/$t"
  done
}

echo "=== stale dist: go on PATH rebuilds instead of installing it ==="
STALE_ROOT="$(mktemp -d)"
STALE_BIN="$(mktemp -d)"
stale_dist_root "$STALE_ROOT"
OUT="$(AGENT_PRESENCE_BIN="$STALE_BIN" bash "$STALE_ROOT/install.sh" 2>&1)"
RC=$?
assert "exits 0" "$RC" "0"
assert_contains "says it's building gorelay from source over stale dist/" "$OUT" \
  "gorelay: dist/$GORELAY_DIST is older than go/ source, building from source instead"
assert "gorelay installed" "$([[ -x "$STALE_BIN/gorelay" ]] && echo yes || echo no)" "yes"
assert_not_contains "did not install the stale stub" "$(cat "$STALE_BIN/gorelay" 2>/dev/null)" \
  "stale-stub"
assert_contains "names the prebuilt path for a fresh dist/ binary" "$OUT" \
  "presenced: installing prebuilt dist/$PRESENCED_DIST"
assert_contains "names the source path when there's no dist/ binary at all" "$OUT" \
  "agent-presence-mcp: building from source"

echo "=== stale dist: no go on PATH warns and installs it anyway ==="
STALE_NOGO_ROOT="$(mktemp -d)"
STALE_NOGO_BIN="$(mktemp -d)"
NOGO_SHIM="$(mktemp -d)"
stale_dist_root "$STALE_NOGO_ROOT"
nogo_path "$NOGO_SHIM"
# AGENT_PRESENCE_BIN goes after env -i, not before it — env -i clears the
# environment env itself inherits, so a plain prefix assignment never
# reaches the child and install.sh silently falls back to its own
# $HOME/.local/bin default. bash is invoked by its shimmed path so env -i
# resolves the command against $NOGO_SHIM, not whatever PATH this test
# script is already running under.
OUT="$(env -i PATH="$NOGO_SHIM" HOME="$HOME" AGENT_PRESENCE_BIN="$STALE_NOGO_BIN" \
  "$NOGO_SHIM/bash" "$STALE_NOGO_ROOT/install.sh" 2>&1)"
assert_contains "warns dist/ is stale with no go to rebuild it" "$OUT" \
  "WARNING: gorelay: dist/$GORELAY_DIST looks older than go/ source"
assert "installs the stale binary anyway, nothing better to do" \
  "$([[ -x "$STALE_NOGO_BIN/gorelay" ]] && echo yes || echo no)" "yes"
assert_contains "installed binary is the stale stub" \
  "$(cat "$STALE_NOGO_BIN/gorelay" 2>/dev/null)" "stale-stub"

echo
if [[ "$FAILS" -eq 0 ]]; then
  echo "all checks passed"
  exit 0
fi
echo "$FAILS check(s) failed"
exit 1
