#!/usr/bin/env bash
# Cross-compiles presenced and agent-presence-mcp for every target platform
# (#21, #32). No cgo, so no per-target toolchain: one machine with `go` on
# PATH produces all ten.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OUT="${1:-$ROOT/dist}"
mkdir -p "$OUT"
# Canonicalize now, before the cd below: a relative $OUT (e.g. the plain
# "dist" release.yml passes) would otherwise resolve against go/ instead of
# the caller's cwd once this script changes directory, silently writing
# binaries somewhere the release workflow's glob never looks.
OUT="$(cd "$OUT" && pwd)"

TARGETS=(
  "linux amd64"
  "linux arm64"
  "darwin arm64"
  "darwin amd64"
  "windows amd64"
)

BINARIES=(presenced agent-presence-mcp)

cd "$ROOT/go"
for t in "${TARGETS[@]}"; do
  read -r goos goarch <<<"$t"
  ext=""
  [[ "$goos" == "windows" ]] && ext=".exe"
  for bin in "${BINARIES[@]}"; do
    name="$bin-$goos-$goarch$ext"
    echo "building $name"
    CGO_ENABLED=0 GOOS="$goos" GOARCH="$goarch" \
      go build -o "$OUT/$name" "./cmd/$bin"
  done
done

echo "done: $OUT"
ls -la "$OUT"
