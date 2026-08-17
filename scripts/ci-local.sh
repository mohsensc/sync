#!/usr/bin/env bash
# Run .github/workflows/ci.yml locally, step for step, in the same order.
#
# Why: GitHub Actions minutes ran out. Without this the only way to know
# whether main is green is to read the workflow and run the steps by hand,
# which is how a `| tail` ended up eating a tsc failure's exit code.
#
# Every step's status is checked. Nothing is piped to tail. Logs land in
# .ci-local/<job>.log; the summary at the end is the answer.
#
#   scripts/ci-local.sh              # all four jobs
#   scripts/ci-local.sh web go       # just those
#
# Known deltas from the runner, since this is a mac and that's ubuntu-24.04:
#   python  3.12 via uv, not actions/setup-python
#   cpp     the system compiler (clang++), not g++
#   web     node is whatever's on PATH, not pinned to 22
# pnpm and the go toolchain are pinned to the same versions CI resolves.

set -uo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LOGS="$REPO/.ci-local"
PNPM_VERSION=10.34.5    # .github/workflows/ci.yml, pnpm/action-setup

mkdir -p "$LOGS"
: > "$LOGS/summary.txt"

# --- step plumbing ---------------------------------------------------------
#
# One log file per job, appended to across that job's steps, so a failure
# reads in the order it happened.

JOB=""          # current job name, for the log path
JOB_FAILED=0
declare -a FAILED_JOBS=()
declare -a PASSED_JOBS=()

log() { printf '%s\n' "$*" | tee -a "$LOGS/summary.txt"; }

job_start() {
  JOB="$1"
  JOB_FAILED=0
  : > "$LOGS/$JOB.log"
  printf '\n=== job: %s ===\n' "$JOB"
}

# step <name> <command...> — runs it, tees to the job log, records failure.
# Skipped once a step in this job has failed: CI stops the job at the first
# red step, so continuing would report failures the runner never reaches.
step() {
  local name="$1"; shift
  if [ "$JOB_FAILED" -ne 0 ]; then
    printf '  skip  %s (a previous step failed)\n' "$name"
    return 0
  fi
  printf '  ....  %s\n' "$name"
  {
    printf '\n----- step: %s -----\n' "$name"
    printf '$ %s\n' "$*"
  } >> "$LOGS/$JOB.log"
  if "$@" >> "$LOGS/$JOB.log" 2>&1; then
    printf '\r  ok    %s\n' "$name"
  else
    local rc=$?
    printf '\r  FAIL  %s (exit %d)\n' "$name" "$rc"
    printf '        %s\n' "$LOGS/$JOB.log"
    JOB_FAILED=1
  fi
}

job_end() {
  if [ "$JOB_FAILED" -eq 0 ]; then
    PASSED_JOBS+=("$JOB")
  else
    FAILED_JOBS+=("$JOB")
  fi
}

# --- python ----------------------------------------------------------------

py_preflight() {
  "$PY" -c 'import sys; assert sys.version_info >= (3, 12), sys.version' &&
  "$PY" --version && go version
}

py_build_gorelay() {
  ( cd "$REPO/go" && go build -o bin/gorelay ./cmd/gorelay )
}

py_install() {
  ( cd "$REPO/python" &&
    "$PY" -m pip install --quiet --upgrade pip &&
    "$PY" -m pip install --quiet -e '.[dev]' &&
    "$PY" -c 'import pytest, hypothesis, websockets' )
}

py_pytest() {
  # The black-box relay suite spawns this binary, same as the CI step's
  # AGENT_PRESENCE_GORELAY_BIN export.
  ( cd "$REPO/python" &&
    AGENT_PRESENCE_GORELAY_BIN="$REPO/go/bin/gorelay" "$PY" -m pytest -q )
}

job_python() {
  job_start python
  # actions/setup-python's stand-in. A 3.14 interpreter is not what CI runs
  # and pyproject's floor is what we claim to support.
  if ! command -v uv >/dev/null; then
    printf '  FAIL  uv is not on PATH; needed to get a 3.12 interpreter\n'
    JOB_FAILED=1; job_end; return
  fi
  local venv="$LOGS/venv312"
  if [ ! -x "$venv/bin/python" ]; then
    step "setup-python 3.12 (uv venv)" uv venv --seed --python 3.12 "$venv"
  fi
  PY="$venv/bin/python"
  step "preflight" py_preflight
  step "build gorelay" py_build_gorelay
  step "install with dev extras" py_install
  step "pytest" py_pytest
  job_end
}

# --- cpp -------------------------------------------------------------------

cpp_preflight() {
  for t in cmake ctest; do
    command -v "$t" >/dev/null || { echo "error: $t is not on PATH"; return 1; }
  done
  command -v c++ >/dev/null || { echo "error: no c++ on PATH"; return 1; }
  c++ --version | head -1
  cmake --version | head -1
}

job_cpp() {
  job_start cpp
  step "preflight" cpp_preflight
  step "configure" cmake -S "$REPO/cpp" -B "$REPO/cpp/build" -DCMAKE_BUILD_TYPE=Release
  step "build" cmake --build "$REPO/cpp/build" -j"$(sysctl -n hw.ncpu 2>/dev/null || nproc)"
  step "ap_tests" "$REPO/cpp/build/ap_tests"
  step "ctest" ctest --test-dir "$REPO/cpp/build" --output-on-failure --no-tests=error
  job_end
}

# --- go --------------------------------------------------------------------

go_wanted() { sed -nE 's/^go ([0-9.]+).*/\1/p' "$REPO/go/go.mod" | head -1; }

go_preflight() {
  go version
  local want have
  want="$(go_wanted)"
  have="$(go env GOVERSION)"; have="${have#go}"
  [ "$have" = "$want" ] || {
    echo "note: go.mod asks for $want, PATH has $have (setup-go would pin $want)"
  }
}

go_in() { ( cd "$REPO/go" && "$@" ); }

job_go() {
  job_start go
  step "preflight" go_preflight
  step "vet" go_in go vet ./...
  step "build" go_in go build ./...
  step "test -race" go_in go test ./... -race -count=1
  step "cross-compile every release target" \
    bash "$REPO/scripts/build-go-release.sh" "$LOGS/dist"
  job_end
}

# --- web -------------------------------------------------------------------

web_in() { ( cd "$REPO/web" && "$@" ); }

# pnpm/action-setup pins 9.15.4. A newer pnpm on PATH resolves the same
# lockfile but is not the thing CI runs, so go through npx at the pin.
PNPM=(npx --yes "pnpm@$PNPM_VERSION")

web_install() { web_in "${PNPM[@]}" install --frozen-lockfile; }
web_verify()  { web_in "${PNPM[@]}" run verify-toolchain; }
web_test()    { web_in "${PNPM[@]}" run test; }
web_types()   { web_in "${PNPM[@]}" run typecheck; }

# The runner's "assert typecheck actually read the sources" step, verbatim
# in intent: every project .ts must appear in tsc's file list.
web_typecheck_coverage() {
  ( cd "$REPO/web" &&
    set -euo pipefail
    find src test -name '*.ts' | sort > "$LOGS/ts-on-disk.txt"
    ./node_modules/.bin/tsc --noEmit --listFilesOnly |
      grep -v node_modules | sed "s|^$PWD/||" | sort > "$LOGS/ts-checked.txt"
    missing="$(comm -23 "$LOGS/ts-on-disk.txt" "$LOGS/ts-checked.txt")"
    echo "$(wc -l < "$LOGS/ts-checked.txt" | tr -d ' ') files typechecked, \
$(wc -l < "$LOGS/ts-on-disk.txt" | tr -d ' ') project files on disk"
    [ -z "$missing" ] || { echo "error: tsc never read:"; echo "$missing"; exit 1; }
  )
}

job_web() {
  job_start web
  step "install" web_install
  step "verify toolchain" web_verify
  step "test" web_test
  step "typecheck" web_types
  step "assert typecheck actually read the sources" web_typecheck_coverage
  job_end
}

# --- main ------------------------------------------------------------------

ALL=(python cpp go web)
WANT=("$@")
[ "${#WANT[@]}" -eq 0 ] && WANT=("${ALL[@]}")

for j in "${WANT[@]}"; do
  case "$j" in
    python) job_python ;;
    cpp)    job_cpp ;;
    go)     job_go ;;
    web)    job_web ;;
    *)      echo "unknown job: $j (have: ${ALL[*]})" >&2; exit 2 ;;
  esac
done

printf '\n=== summary ===\n'
for j in "${PASSED_JOBS[@]:-}"; do [ -n "$j" ] && log "pass  $j"; done
for j in "${FAILED_JOBS[@]:-}"; do [ -n "$j" ] && log "FAIL  $j  ($LOGS/$j.log)"; done

if [ "${#FAILED_JOBS[@]}" -gt 0 ]; then
  printf '\n%d of %d jobs red\n' "${#FAILED_JOBS[@]}" "${#WANT[@]}"
  exit 1
fi
printf '\nall %d jobs green\n' "${#WANT[@]}"
