// Resolves a binary name to an absolute path inside the per-platform
// optionalDependency package, at runtime, via require.resolve. No files get
// copied or symlinked at install time - that's the whole point of shipping
// as optionalDependencies instead of a postinstall download (see
// docs/install-plan.md). require.resolve also means this keeps working no
// matter how deep node_modules nests the platform package.

const PLATFORM_PACKAGES = {
  'darwin-arm64': '@agent-sync/darwin-arm64',
  'darwin-x64': '@agent-sync/darwin-x64',
  'linux-x64': '@agent-sync/linux-x64',
  'linux-arm64': '@agent-sync/linux-arm64',
  'win32-x64': '@agent-sync/win32-x64',
};

// Binaries that every platform package is expected to ship. ap-hook is
// handled separately below because a platform package can legitimately
// ship without it (see install-plan.md's "degradation is explicit" note).
const REQUIRED_BINARIES = new Set(['presenced', 'agent-sync-mcp', 'gorelay']);

function platformKey() {
  return `${process.platform}-${process.arch}`;
}

function packageNameFor(key) {
  return PLATFORM_PACKAGES[key];
}

function exeSuffix() {
  return process.platform === 'win32' ? '.exe' : '';
}

function unsupportedPlatformError(key) {
  const supported = Object.keys(PLATFORM_PACKAGES).join(', ');
  return new Error(
    `agent-sync has no build for ${key}.\n` +
    `Supported platforms: ${supported}.\n` +
    `If you think this platform should be supported, open an issue - ` +
    `there's nothing you can change locally to fix this.`
  );
}

function missingPackageError(pkgName, key, cause) {
  const err = new Error(
    `agent-sync: the platform package ${pkgName} (for ${key}) is not installed.\n` +
    `This is not caused by --ignore-scripts - platform packages are plain ` +
    `optionalDependencies and need no install scripts to work.\n` +
    `Likely causes: the optional dependency failed to resolve for this platform/arch, ` +
    `or the install was interrupted.\n` +
    `Try: npm i -g agent-sync --force\n` +
    `Or check that ${pkgName} exists on your configured registry.`
  );
  if (cause) err.cause = cause;
  return err;
}

// Package resolved fine, but a binary we require isn't in it - a corrupt
// or partial publish of the platform package, not a resolution failure.
// Different message from missingPackageError() because "reinstall" isn't
// necessarily the fix and blaming --ignore-scripts would be even less
// accurate here.
function missingBinaryError(name, pkgName, binPath) {
  return new Error(
    `agent-sync: ${pkgName} is installed but doesn't contain '${name}' ` +
    `(expected at ${binPath}).\n` +
    `This looks like a corrupt or partial install of that package.\n` +
    `Try: npm i -g agent-sync --force`
  );
}

// Finds the platform package's own package.json so we can resolve binaries
// relative to its directory, whatever that directory turns out to be.
function resolvePlatformPackageDir(pkgName, key) {
  let pkgJsonPath;
  try {
    pkgJsonPath = require.resolve(`${pkgName}/package.json`);
  } catch (err) {
    throw missingPackageError(pkgName, key, err);
  }
  return require('path').dirname(pkgJsonPath);
}

// Resolves `name` (e.g. "presenced", "gorelay") to an absolute path.
// Throws for missing/unsupported platforms. Use binaryOptional() for
// ap-hook, which is allowed to be absent.
function binary(name) {
  const key = platformKey();
  const pkgName = packageNameFor(key);
  if (!pkgName) throw unsupportedPlatformError(key);

  const dir = resolvePlatformPackageDir(pkgName, key);
  const path = require('path');
  const fs = require('fs');
  const binPath = path.join(dir, 'bin', name + exeSuffix());

  if (!fs.existsSync(binPath)) {
    if (REQUIRED_BINARIES.has(name)) {
      throw missingBinaryError(name, pkgName, binPath);
    }
    return null;
  }
  return binPath;
}

// Same resolution as binary(), but never throws for a missing binary -
// returns null instead. Meant for ap-hook: a platform package may ship
// without it (see install-plan.md), and that's a degraded-but-working state,
// not an error.
function binaryOptional(name) {
  const key = platformKey();
  const pkgName = packageNameFor(key);
  if (!pkgName) return null;

  let dir;
  try {
    dir = resolvePlatformPackageDir(pkgName, key);
  } catch {
    return null;
  }

  const path = require('path');
  const fs = require('fs');
  const binPath = path.join(dir, 'bin', name + exeSuffix());
  return fs.existsSync(binPath) ? binPath : null;
}

// What doctor needs to tell three different situations apart, which the
// binary lookups above collapse into one error: this platform has no build
// at all, the package exists but was never installed, or it's fine. Callers
// get all three from one call instead of inferring them from a thrown
// message.
function platformPackage() {
  const key = platformKey();
  const name = packageNameFor(key);
  if (!name) return { key, name: null, supported: false, installed: false, dir: null };
  try {
    return { key, name, supported: true, installed: true, dir: resolvePlatformPackageDir(name, key) };
  } catch {
    return { key, name, supported: true, installed: false, dir: null };
  }
}

module.exports = {
  binary,
  binaryOptional,
  platformPackage,
  platformKey,
  exeSuffix,
};
