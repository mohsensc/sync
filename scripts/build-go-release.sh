#!/usr/bin/env bash
# Cross-compiles presenced, agent-presence-mcp and gorelay for every target
# platform (#21, #32, #40). No cgo, so no per-target toolchain: one machine
# with `go` on PATH produces all fifteen.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OUT="${1:-$ROOT/dist}"
mkdir -p "$OUT"

TARGETS=(
  "linux amd64"
  "linux arm64"
  "darwin arm64"
  "darwin amd64"
  "windows amd64"
)

BINARIES=(presenced agent-presence-mcp gorelay)

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
