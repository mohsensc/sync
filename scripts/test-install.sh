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
NPM_SHIM=""
NPM_HOME=""
NPM_AP_HOME=""
trap 'rm -rf "$HAPPY_ROOT" "$HAPPY_BIN" "$BROKEN_ROOT" "$BROKEN_BIN" "$NOHOOK_ROOT" "$NOHOOK_BIN" "$STALE_ROOT" "$STALE_BIN" "$STALE_NOGO_ROOT" "$STALE_NOGO_BIN" "$NOGO_SHIM" "$NPM_SHIM" "$NPM_HOME" "$NPM_AP_HOME"' EXIT
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

# --- the PreToolUse matcher covers every tool verb_for calls an edit ------
#
# install.sh wires the hook up by tool name; verb_for decides which tools
# arbitrate. Nothing kept the two in step, and MultiEdit fell through the
# gap: verb_for called it an edit, wants_decision routed it to a decision,
# and the matcher never named it — so Claude Code never invoked the hook
# for it at all and every MultiEdit went unarbitrated. Derive the expected
# list from hook.cpp rather than restating it, so a new edit tool cannot
# ship wired into one and not the other.
echo
echo "-- PreToolUse matcher covers every edit-verb tool"
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
EDIT_TOOLS="$(sed -n 's/.*if (tool == \(.*\)) {/\1/p' "$REPO_ROOT/cpp/hook/hook.cpp" | head -1 | grep -o '"[A-Za-z]*"' | tr -d '"')"
MATCHER="$(sed -n 's/.*"matcher": "\(.*\)",/\1/p' "$REPO_ROOT/install.sh" | head -1)"
for tool in $EDIT_TOOLS; do
  case "|$MATCHER|" in
    *"|$tool|"*) assert "matcher names $tool" "yes" "yes" ;;
    *) assert "matcher names $tool (verb_for calls it an edit)" "no" "yes" ;;
  esac
done


# --- npm wrapper, clean toolchain-free environment ------------------------
#
# npm/agent-presence/ is the wrapper package (docs/install-plan.md): the
# whole pitch is `npm i -g agent-presence` needing no go, no cmake, nothing
# beyond node. This section proves that claim rather than asserting it.
# Skips (not fails) if the package isn't there yet - other agents are
# writing it as this lands, and ordering shouldn't break this file.
NPM_DIR="$REPO_ROOT/npm/agent-presence"
BIN_JS="$NPM_DIR/bin/agent-presence.js"

echo
echo "-- npm wrapper (clean, toolchain-free environment)"
if [[ ! -f "$BIN_JS" ]] || ! command -v node >/dev/null; then
  echo "  skip  npm/agent-presence/bin/agent-presence.js or node not present yet"
else
  # Same nogo_path() the stale-dist tests use, plus node symlinked in -
  # not edited, since the stale-dist cases depend on its current contents
  # exactly as they are.
  NPM_SHIM="$(mktemp -d)"
  nogo_path "$NPM_SHIM"
  ln -sf "$(command -v node)" "$NPM_SHIM/node"

  # Fresh HOME and AGENT_PRESENCE_HOME per run, so doctor's settings.json /
  # server.json / config.json checks read a clean slate instead of whoever
  # happens to be running this script.
  NPM_HOME="$(mktemp -d)"
  NPM_AP_HOME="$(mktemp -d)"

  npm_env_run() {
    env -i PATH="$NPM_SHIM" HOME="$NPM_HOME" AGENT_PRESENCE_HOME="$NPM_AP_HOME" \
      "$NPM_SHIM/node" "$BIN_JS" "$@" 2>&1
  }

  # Smoke-check the shim itself first - if this fails, every assertion
  # below is testing a broken harness, not a broken wrapper, and should
  # read as such rather than as a pile of unrelated FAILs.
  SHIM_SMOKE="$(env -i PATH="$NPM_SHIM" HOME="$NPM_HOME" "$NPM_SHIM/node" -e 'console.log(1)' 2>&1)"
  assert "shim node runs at all" "$SHIM_SMOKE" "1"

  # The claim is "no go, no cmake" - assert the absence before leaning on
  # it, not just that the wrapper happens to work anyway.
  # command -v is a bash builtin, not an executable - env -i can't exec it
  # directly, so route it through the shimmed bash the same way the
  # stale-dist test above invokes install.sh.
  GO_ON_SHIM="$(env -i PATH="$NPM_SHIM" HOME="$NPM_HOME" "$NPM_SHIM/bash" -c 'command -v go' 2>&1 || true)"
  CMAKE_ON_SHIM="$(env -i PATH="$NPM_SHIM" HOME="$NPM_HOME" "$NPM_SHIM/bash" -c 'command -v cmake' 2>&1 || true)"
  assert "no go on the shim PATH" "$GO_ON_SHIM" ""
  assert "no cmake on the shim PATH" "$CMAKE_ON_SHIM" ""

  OUT="$(npm_env_run help)"
  RC=$?
  assert "'help' exits 0" "$RC" "0"
  assert_contains "'help' prints usage" "$OUT" "agent-presence - multi-agent presence"

  OUT="$(npm_env_run bogus-subcommand)"
  RC=$?
  assert "unknown subcommand exits non-zero" "$([[ "$RC" -ne 0 ]] && echo yes || echo no)" "yes"
  assert_contains "unknown subcommand names itself in the error" "$OUT" "unknown command 'bogus-subcommand'"

  # doctor with no platform packages installed (no node_modules under
  # npm/agent-presence in this checkout) and no go/cmake on PATH. The
  # platform package for this host is supported but not installed, so
  # checkPlatformPackage() fails fast and the four per-binary checks are
  # skipped rather than run - doctor's own "not checked" line, not a crash.
  # That's a real fail (exit 1), which is correct for a from-scratch
  # checkout with nothing installed, not a bug in doctor.
  OUT="$(npm_env_run doctor)"
  RC=$?
  assert "'doctor' exits non-zero with no platform package installed" \
    "$([[ "$RC" -ne 0 ]] && echo yes || echo no)" "yes"
  assert_contains "doctor names itself" "$OUT" "agent-presence doctor"
  assert_contains "doctor checks node version" "$OUT" "node "
  assert_contains "doctor checks the platform package" "$OUT" "platform package"
  assert_contains "doctor checks claude settings.json" "$OUT" "claude settings.json"
  # Either line is a pass: with no `claude` on the shim PATH doctor reports
  # the missing CLI instead of the registration state, which is the more
  # useful of the two answers. Asserting only the latter made this fail for
  # the wrong reason - doctor was right, the expectation wasn't.
  case "$OUT" in
    *"mcp registration"*|*"claude CLI"*)
      assert "doctor covers mcp registration or a missing claude CLI" "yes" "yes" ;;
    *)
      assert "doctor covers mcp registration or a missing claude CLI" "no" "yes" ;;
  esac
  assert_contains "doctor reports mode" "$OUT" "mode"
  assert_contains "doctor prints a summary line" "$OUT" "summary:"
  assert_contains "doctor's platform-package failure says how to fix it" "$OUT" \
    "npm i -g agent-presence --force"

  # --ignore-scripts framing: doctor's missing-package message actively
  # denies the usual "must be --ignore-scripts" assumption, so assert what
  # it DOES say, not that "--ignore-scripts" is absent - the string is right
  # there in the reassurance sentence. doctor words this differently from
  # resolve.js's own thrown message (asserted verbatim further down); both
  # deny it, so match the phrase they share.
  assert_contains "missing platform package blames itself, not --ignore-scripts" "$OUT" \
    "--ignore-scripts"

  # -- resolve.js: unsupported platform -------------------------------
  #
  # process.platform/process.arch are read-only own-properties; the only
  # way to drive resolve.js down its "no build for this platform" branch
  # from outside is to redefine them before requiring it, in a throwaway
  # node -e process. A fictional, stable pair (not this machine's real
  # platform/arch) so the asserted key never depends on where this runs.
  UNSUPPORTED_OUT="$("$NPM_SHIM/node" -e '
    Object.defineProperty(process, "platform", { value: "sunos" });
    Object.defineProperty(process, "arch", { value: "mips" });
    const resolve = require(process.argv[1]);
    try {
      resolve.binary("gorelay");
      console.log("NO ERROR THROWN");
    } catch (e) {
      console.log(e.message);
    }
  ' "$NPM_DIR/lib/resolve.js" 2>&1)"
  assert_contains "unsupported platform names the platform" "$UNSUPPORTED_OUT" "sunos-mips"
  assert_contains "unsupported platform lists darwin-arm64 as supported" "$UNSUPPORTED_OUT" "darwin-arm64"
  assert_contains "unsupported platform lists linux-x64 as supported" "$UNSUPPORTED_OUT" "linux-x64"

  # -- resolve.js: platform supported, package not installed ----------
  #
  # Forced to linux/x64 rather than relying on this host's own platform
  # being uninstalled - that stays true today (no node_modules here) but
  # would silently stop testing anything the day someone runs `npm i`
  # locally.
  MISSING_PKG_OUT="$("$NPM_SHIM/node" -e '
    Object.defineProperty(process, "platform", { value: "linux" });
    Object.defineProperty(process, "arch", { value: "x64" });
    const resolve = require(process.argv[1]);
    try {
      resolve.binary("gorelay");
      console.log("NO ERROR THROWN");
    } catch (e) {
      console.log(e.message);
    }
  ' "$NPM_DIR/lib/resolve.js" 2>&1)"
  assert_contains "missing platform package names the package" "$MISSING_PKG_OUT" "@agent-presence/linux-x64"
  assert_contains "missing platform package gives an actionable next step" "$MISSING_PKG_OUT" \
    "npm i -g agent-presence --force"
  assert_contains "missing platform package doesn't blame --ignore-scripts" "$MISSING_PKG_OUT" \
    "not caused by --ignore-scripts"

  # -- node version guard ----------------------------------------------
  #
  # Overriding process.versions.node (not process.version, which stays
  # real) is what checkNodeVersion() in bin/agent-presence.js actually
  # reads.
  OLD_NODE_OUT="$("$NPM_SHIM/node" -e '
    Object.defineProperty(process.versions, "node", { value: "16.20.0" });
    process.argv = [process.argv[0], process.argv[1], "help"];
    require(process.argv[1]);
  ' "$BIN_JS" 2>&1)"
  OLD_NODE_RC=$?
  assert "old node exits non-zero" "$([[ "$OLD_NODE_RC" -ne 0 ]] && echo yes || echo no)" "yes"
  assert_contains "old node names the requirement" "$OLD_NODE_OUT" "needs Node 18 or newer"
fi

echo
if [[ "$FAILS" -eq 0 ]]; then
  echo "all checks passed"
  exit 0
fi
echo "$FAILS check(s) failed"
exit 1
