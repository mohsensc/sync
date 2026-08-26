#!/usr/bin/env bash
# Builds the binaries and generates the five npm/platform/<os>-<arch>
# packages that npm/agent-presence's optionalDependencies point at.
#
# Go binaries (presenced, agent-presence-mcp, gorelay) cross-compile for all
# five targets via scripts/build-go-release.sh — no cgo, one machine, no
# per-target toolchain.
#
# ap-hook does not. It's C++20 and this machine has no zig and no way for
# Apple clang to target Linux or Windows, so it only gets built for the host
# platform via cmake. Every platform package that isn't the host's gets a
# hook-shaped hole: no ap-hook binary, everything else still ships. `doctor`
# is what tells a user their platform is missing arbitration and why — this
# script just says, plainly, who got a hook and who didn't.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DIST="$ROOT/dist"
PLATFORM_DIR="$ROOT/npm/platform"
WRAPPER_DIR="$ROOT/npm/agent-presence"
DIST_NPM="$ROOT/dist-npm"

# name -> "goos goarch" for the Go build, plus the npm platform/arch names
# npm actually checks (process.platform/process.arch), which don't match
# Go's spelling for two of these.
TARGETS=(
  "darwin-arm64 darwin arm64"
  "darwin-x64 darwin amd64"
  "linux-x64 linux amd64"
  "linux-arm64 linux arm64"
  "win32-x64 windows amd64"
)

GO_BINARIES=(presenced agent-presence-mcp gorelay)

VERSION="$(node -p "require('$WRAPPER_DIR/package.json').version")"

# Host platform, for the one ap-hook build we can actually do.
HOST_GOOS="$(uname -s | tr '[:upper:]' '[:lower:]')"
HOST_ARCH="$(uname -m)"
case "$HOST_ARCH" in
  x86_64) HOST_GOARCH=amd64; HOST_NPM_ARCH=x64 ;;
  arm64|aarch64) HOST_GOARCH=arm64; HOST_NPM_ARCH=arm64 ;;
  *) HOST_GOARCH="$HOST_ARCH"; HOST_NPM_ARCH="$HOST_ARCH" ;;
esac
case "$HOST_GOOS" in
  darwin) HOST_NPM_OS=darwin ;;
  linux) HOST_NPM_OS=linux ;;
  *) HOST_NPM_OS="$HOST_GOOS" ;;
esac
HOST_PKG="$HOST_NPM_OS-$HOST_NPM_ARCH"

echo "== building go binaries for all five platforms =="
"$ROOT/scripts/build-go-release.sh" "$DIST"

echo
echo "== building ap-hook for host platform only ($HOST_PKG) =="
cmake -S "$ROOT/cpp" -B "$ROOT/cpp/build" -DCMAKE_BUILD_TYPE=Release >/dev/null
cmake --build "$ROOT/cpp/build" --target ap-hook >/dev/null
echo "ap-hook built for $HOST_PKG"

echo
echo "== generating npm/platform packages (version $VERSION) =="
# Clean only the generated <os>-<arch>/ dirs, never the whole PLATFORM_DIR —
# npm/platform/README.md is checked in and lives right next to them.
mkdir -p "$PLATFORM_DIR"
for t in "${TARGETS[@]}"; do
  read -r pkgname _ _ <<<"$t"
  rm -rf "$PLATFORM_DIR/$pkgname"
done

for t in "${TARGETS[@]}"; do
  read -r pkgname goos goarch <<<"$t"
  case "$goos" in
    windows) npm_os=win32 ;;
    *) npm_os="$goos" ;;
  esac
  case "$goarch" in
    amd64) npm_arch=x64 ;;
    *) npm_arch="$goarch" ;;
  esac
  ext=""
  [[ "$goos" == "windows" ]] && ext=".exe"

  pkg_dir="$PLATFORM_DIR/$pkgname"
  bin_dir="$pkg_dir/bin"
  mkdir -p "$bin_dir"

  for bin in "${GO_BINARIES[@]}"; do
    src="$DIST/$bin-$goos-$goarch$ext"
    cp "$src" "$bin_dir/$bin$ext"
    chmod +x "$bin_dir/$bin$ext"
  done

  hook_note="no ap-hook (not built on this machine for $pkgname — see script header)"
  if [[ "$pkgname" == "$HOST_PKG" ]]; then
    cp "$ROOT/cpp/build/ap-hook" "$bin_dir/ap-hook"
    chmod +x "$bin_dir/ap-hook"
    hook_note="ap-hook included (built on this machine)"
  fi

  cat >"$pkg_dir/package.json" <<JSON
{
  "name": "@agent-presence/$pkgname",
  "version": "$VERSION",
  "description": "agent-presence prebuilt binaries for $npm_os/$npm_arch",
  "license": "MIT",
  "os": ["$npm_os"],
  "cpu": ["$npm_arch"],
  "files": ["bin"]
}
JSON

  echo "  $pkgname: $hook_note"
done

echo
echo "platform packages written to $PLATFORM_DIR"
echo "version stamped from $WRAPPER_DIR/package.json (single source of truth): $VERSION"

if [[ "${1:-}" == "--pack" ]]; then
  echo
  echo "== packing tarballs into $DIST_NPM =="
  rm -rf "$DIST_NPM"
  mkdir -p "$DIST_NPM"

  for t in "${TARGETS[@]}"; do
    read -r pkgname _ _ <<<"$t"
    (cd "$PLATFORM_DIR/$pkgname" && npm pack --pack-destination "$DIST_NPM" >/dev/null)
  done
  (cd "$WRAPPER_DIR" && npm pack --pack-destination "$DIST_NPM" >/dev/null)

  echo "tarballs:"
  ls -1 "$DIST_NPM"

  echo
  echo "This is the only install path verified end to end without publishing"
  echo "to the registry — npm i -g of real tarballs, resolving the"
  echo "optionalDependency locally instead of hitting npm. Paths must be"
  echo "absolute or './'-prefixed, or npm parses them as git specs. Try it:"
  echo
  echo "  npm i -g $DIST_NPM/agent-presence-$VERSION.tgz $DIST_NPM/agent-presence-$HOST_PKG-$VERSION.tgz"
  echo
  echo "That proves the optionalDependency resolves. It does not prove the"
  echo "'agent-presence' command works: bin/agent-presence.js in the wrapper"
  echo "package is owned by other work in this branch and may not exist yet."
fi
