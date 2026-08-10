#!/usr/bin/env bash
# Assert the local test/typecheck binaries exist and match the lockfile.
#
# Why this exists: `npx vitest` quietly fetched 4.1.10 instead of the pinned
# 2.1.9, and `npx tsc` fetches an unrelated registry package that prints "This
# is not the tsc command you are looking for" and exits 1. Both only happen when
# node_modules is missing. So: fail here, loudly, rather than let a run pass or
# fail on the wrong tool.
set -euo pipefail

cd "$(dirname "$0")/.."

lock_version() {
  # First "  <name>@<x.y.z>:" key in the packages: section. Two-space anchor so
  # `vitest` can't match `@vitest/expect` and `vite` can't match `vitest`.
  grep -oE "^  $1@[0-9]+\.[0-9]+\.[0-9]+:" pnpm-lock.yaml |
    head -1 | sed -E "s/^  $1@//; s/:\$//"
}

check() {
  local pkg="$1" bin="node_modules/.bin/$2" want got
  want="$(lock_version "$pkg")"
  if [ -z "$want" ]; then
    echo "error: no $pkg version in web/pnpm-lock.yaml" >&2
    exit 1
  fi
  if [ ! -x "$bin" ]; then
    echo "error: web/$bin is missing or not executable." >&2
    echo "       Dependencies were not installed. Run 'pnpm install --frozen-lockfile'." >&2
    echo "       Do not fall back to npx: it resolves a different package." >&2
    exit 1
  fi
  got="$("$bin" --version 2>&1 | grep -oE '[0-9]+\.[0-9]+\.[0-9]+' | head -1)"
  if [ "$got" != "$want" ]; then
    echo "error: $2 reports $got but pnpm-lock.yaml pins $want." >&2
    echo "       Something resolved a binary other than the local one." >&2
    exit 1
  fi
  echo "ok: $2 $got from $bin"
}

check vitest vitest
check typescript tsc
