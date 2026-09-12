'use strict';

// API notes (resolve.js/state.js are owned by another agent):
//   lib/resolve.js: binary(name) throws, binaryOptional(name) -> path|null,
//                   platformPackage() -> { key, name, supported, installed, dir }.
//   lib/state.js: readServer()/readConfig() -> parsed JSON or null,
//                 serverPath()/logPath() -> absolute paths for messages,
//                 isServerLive(server) -> Promise<boolean> (checks pid AND
//                 that the port actually accepts a connection).

const fs = require('fs');
const net = require('net');
const path = require('path');
const os = require('os');
const { execFileSync } = require('child_process');

const resolve = require('./resolve');
const state = require('./state');

const BINARIES = ['gorelay', 'presenced', 'agent-sync-mcp', 'ap-hook'];
const CONNECT_TIMEOUT_MS = 2000;
const RUN_CHECK_TIMEOUT_MS = 3000;
const SUPPORTED_PLATFORMS = ['darwin-arm64', 'darwin-x64', 'linux-x64', 'linux-arm64', 'win32-x64'];

function isApHookCommand(cmd) {
  if (typeof cmd !== 'string') return false;
  const base = path.basename(cmd);
  return base === 'ap-hook' || base === 'ap-hook.exe';
}

// One doctor run = one `failed` count. `report` is passed down instead of
// living at module scope so a caller invoking run() twice in the same
// process (tests, mainly) never has the second call inherit the first's
// exit code.
function makeReporter() {
  let failed = false;
  return {
    report(status, label, detail, nextStep) {
      const tag = status.toUpperCase().padEnd(4);
      process.stdout.write(`[${tag}] ${label}${detail ? ' - ' + detail : ''}\n`);
      if (status !== 'ok' && nextStep) {
        process.stdout.write(`       next: ${nextStep}\n`);
      }
      if (status === 'fail') failed = true;
    },
    failed: () => failed,
  };
}

function checkNodeVersion(report) {
  const version = process.versions.node;
  const major = Number(version.split('.')[0]);
  if (major >= 18) {
    report('ok', `node ${version}`);
  } else {
    report('fail', `node ${version}`, 'agent-sync requires Node >= 18', 'install Node 18 or newer');
  }
}

// Returns true when the per-binary checks are worth running at all. When the
// platform package itself is missing every one of them fails for the same
// reason, and printing that reason four times buries the one line that
// actually tells you what to do.
function checkPlatformPackage(report) {
  const pkg = resolve.platformPackage();

  if (!pkg.supported) {
    report(
      'fail',
      'platform package',
      `no build for ${pkg.key} (supported: ${SUPPORTED_PLATFORMS.join(', ')})`,
      'see docs/install-plan.md for the supported platform list, or build from source'
    );
    return false;
  }

  if (!pkg.installed) {
    report(
      'fail',
      'platform package',
      `${pkg.name} is not installed`,
      'reinstall: npm i -g agent-sync --force. Not an --ignore-scripts problem, ' +
        'platform packages are plain optionalDependencies and run no install scripts.'
    );
    return false;
  }

  report('ok', 'platform package', `${pkg.name} at ${pkg.dir}`);
  return true;
}

// Exit-code-agnostic: a binary that runs and rejects its args (non-zero
// exit) still proved it can execute. Only a spawn failure - wrong arch,
// truncated file, missing interpreter - means "does not run".
function tryRun(binPath, args) {
  try {
    execFileSync(binPath, args, { stdio: 'ignore', timeout: RUN_CHECK_TIMEOUT_MS });
    return { ran: true };
  } catch (e) {
    if (e.code === 'ENOENT' || e.code === 'EACCES' || e.code === 'ENOEXEC') {
      return { ran: false, reason: e.code };
    }
    if (e.signal === 'SIGTERM' && e.killed) {
      return { ran: false, reason: 'timed out' };
    }
    // Non-zero exit from a process that did spawn - counts as "runs".
    return { ran: true };
  }
}

// presenced takes no flags at all (bare invocation starts a daemon), so
// --help is expected to exit non-zero rather than succeed - that is still a
// pass here, see tryRun's contract. ap-hook reads stdin and would otherwise
// hang, hence stdio: 'ignore' plus a hard timeout for all four.
function runArgsFor(name) {
  if (name === 'ap-hook') return [];
  return ['--help'];
}

function checkBinary(report, name) {
  const optional = name === 'ap-hook';
  let p = null;
  try {
    p = optional ? resolve.binaryOptional(name) : resolve.binary(name);
  } catch (e) {
    report('fail', name, e.message, 'reinstall, or build from source per docs/install-plan.md');
    return;
  }

  if (!p) {
    if (optional) {
      report(
        'warn',
        'ap-hook',
        `not available on ${process.platform}/${process.arch}`,
        'still works: relay/daemon/MCP tools (claim_work, respond, who_else_is_here). ' +
          'Not wired: arbitration on tool calls. Build locally: cmake -S cpp -B cpp/build && cmake --build cpp/build'
      );
    } else {
      report('fail', name, 'not resolvable', 'reinstall agent-sync');
    }
    return;
  }

  if (!fs.existsSync(p)) {
    report('fail', name, `resolved to ${p} but that file does not exist`, 'reinstall agent-sync');
    return;
  }

  try {
    fs.accessSync(p, fs.constants.X_OK);
  } catch (e) {
    report('fail', name, `${p} is not executable`, `chmod +x ${p}`);
    return;
  }

  const result = tryRun(p, runArgsFor(name));
  if (!result.ran) {
    const hint =
      optional
        ? `still works: relay/daemon/MCP tools. Not wired: arbitration on tool calls. Rebuild: cmake -S cpp -B cpp/build && cmake --build cpp/build`
        : 'wrong architecture, a truncated download, or a corrupt install - reinstall agent-sync';
    report(optional ? 'warn' : 'fail', name, `resolved to ${p} but would not execute (${result.reason})`, hint);
    return;
  }

  report('ok', name, p);
}

function checkSettingsJson(report) {
  const settingsPath = path.join(os.homedir(), '.claude', 'settings.json');
  if (!fs.existsSync(settingsPath)) {
    report('warn', 'claude settings.json', 'does not exist yet', 'run `agent-sync setup`');
    return;
  }

  let settings;
  try {
    settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
  } catch (e) {
    report('fail', 'claude settings.json', `does not parse as JSON (${e.message})`, `fix or remove ${settingsPath}, then rerun setup`);
    return;
  }

  const pre = (settings.hooks && settings.hooks.PreToolUse) || [];
  const post = (settings.hooks && settings.hooks.PostToolUse) || [];

  const findHook = (list) => {
    for (const entry of list) {
      if (!entry || !Array.isArray(entry.hooks)) continue;
      const hook = entry.hooks.find((h) => h && isApHookCommand(h.command));
      if (hook) return hook.command;
    }
    return null;
  };

  const preCmd = findHook(pre);
  const postCmd = findHook(post);

  if (!preCmd && !postCmd) {
    report('warn', 'claude settings.json hooks', 'ap-hook not wired', 'run `agent-sync setup`');
    return;
  }

  for (const [label, cmd] of [['PreToolUse', preCmd], ['PostToolUse', postCmd]]) {
    if (!cmd) {
      report('warn', `claude settings.json (${label})`, 'ap-hook not wired for this event', 'run `agent-sync setup`');
      continue;
    }
    if (!fs.existsSync(cmd)) {
      report('fail', `claude settings.json (${label})`, `points at ${cmd}, which does not exist`, 'run `agent-sync setup` to repair, or reinstall');
      continue;
    }
    report('ok', `claude settings.json (${label})`, cmd);
  }
}

function checkMcpRegistered(report) {
  try {
    execFileSync('claude', ['--version'], { stdio: 'ignore' });
  } catch (e) {
    report('warn', 'claude CLI', 'not found on PATH', 'install Claude Code, then run `agent-sync setup`');
    return;
  }

  let out;
  try {
    out = execFileSync('claude', ['mcp', 'list'], { encoding: 'utf8' });
  } catch (e) {
    report('warn', 'mcp registration', `\`claude mcp list\` failed (${e.message})`, 'run `agent-sync setup`');
    return;
  }

  const registered = out.split('\n').some((line) => /^agent-sync:/.test(line.trim()));
  if (registered) {
    report('ok', 'mcp registration', 'agent-sync registered');
  } else {
    report('warn', 'mcp registration', 'agent-sync not registered', 'run `agent-sync setup`');
  }
}

function safeReadConfig() {
  try {
    return state.readConfig();
  } catch (e) {
    return null;
  }
}
function safeReadServer() {
  try {
    return state.readServer();
  } catch (e) {
    return null;
  }
}

function checkJoinedOrLocal(report) {
  const config = safeReadConfig();
  if (config && config.relay) {
    report('ok', 'mode', `joined ${config.relay}`);
    return config;
  }
  report('ok', 'mode', 'local (no config.json, this machine runs its own relay)');
  return null;
}

function testConnection(host, port) {
  return new Promise((resolvePromise) => {
    const socket = net.createConnection({ host, port, timeout: CONNECT_TIMEOUT_MS });
    let done = false;
    const finish = (ok, reason) => {
      if (done) return;
      done = true;
      try {
        socket.destroy();
      } catch (e) {
        /* ignore */
      }
      resolvePromise({ ok, reason });
    };
    socket.on('connect', () => finish(true, null));
    socket.on('timeout', () => finish(false, 'timed out'));
    socket.on('error', (e) => finish(false, e.message));
  });
}

function parseHostPort(url) {
  try {
    const u = new URL(url);
    return { host: u.hostname, port: u.port ? Number(u.port) : u.protocol === 'wss:' ? 443 : 80 };
  } catch (e) {
    return null;
  }
}

async function checkRelay(report, joinedConfig) {
  if (joinedConfig) {
    const hp = parseHostPort(joinedConfig.relay);
    if (!hp) {
      report('fail', 'relay (remote)', `config.json has an unparseable relay URL: ${joinedConfig.relay}`, 'run `agent-sync join <blob>` again with a fresh invite');
      return;
    }
    const result = await testConnection(hp.host, hp.port);
    if (result.ok) {
      report('ok', 'relay (remote)', `reached ${joinedConfig.relay}`);
    } else {
      report(
        'fail',
        'relay (remote)',
        `could not reach ${joinedConfig.relay} (${result.reason})`,
        'check network/firewall, confirm the other machine still has the relay running on --host 0.0.0.0'
      );
    }
    return;
  }

  const server = safeReadServer();
  if (!server) {
    report('warn', 'relay (local)', `no ${state.serverPath()}`, 'run `agent-sync start` or `setup`');
    return;
  }

  let alive = false;
  try {
    alive = await state.isServerLive(server);
  } catch (e) {
    alive = false;
  }

  if (!alive) {
    report(
      'fail',
      'relay (local)',
      `server.json exists but pid ${server.pid} is not running - stale state file`,
      `remove ${state.serverPath()} and run \`agent-sync start\``
    );
    return;
  }

  const hp = parseHostPort(server.url || `ws://${server.host}:${server.port}`);
  if (!hp) {
    report('fail', 'relay (local)', 'server.json is alive but its url/host/port could not be parsed', `remove ${state.serverPath()} and run \`agent-sync start\``);
    return;
  }

  const result = await testConnection(hp.host === '0.0.0.0' ? '127.0.0.1' : hp.host, hp.port);
  if (result.ok) {
    report('ok', 'relay (local)', `pid ${server.pid} alive, accepting connections on ${hp.host}:${hp.port}`);
  } else {
    report(
      'fail',
      'relay (local)',
      `pid ${server.pid} alive but port ${hp.port} refused connection (${result.reason})`,
      'check ' + state.logPath() + ' for errors, consider `agent-sync stop` then `agent-sync start`'
    );
  }
}

async function run(argv) {
  const { report, failed } = makeReporter();

  process.stdout.write('agent-sync doctor\n\n');

  checkNodeVersion(report);
  if (checkPlatformPackage(report)) {
    for (const name of BINARIES) checkBinary(report, name);
  } else {
    report('warn', 'binaries', 'not checked - the platform package above has to be fixed first');
  }
  checkSettingsJson(report);
  checkMcpRegistered(report);
  const joinedConfig = checkJoinedOrLocal(report);
  await checkRelay(report, joinedConfig);

  process.stdout.write('\n');
  if (failed()) {
    process.stdout.write('summary: one or more checks FAILED, see next steps above.\n');
    return 1;
  }
  process.stdout.write('summary: all checks passed (warnings, if any, are non-fatal).\n');
  return 0;
}

module.exports = { run };
