'use strict';

// API notes (resolve.js/state.js/start.js are owned by another agent):
//   lib/resolve.js: binary(name) throws, binaryOptional(name) -> path|null.
//   lib/state.js: readConfig() -> parsed ~/.agent-presence/config.json or null
//                 ({ v:1, relay, token?, relayCa? } - written by join.js when
//                 this machine has joined someone else's relay).
//   lib/start.js: run(['start']) starts/reuses a relay the way
//                 `agent-presence start` does, and returns an exit code.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const resolve = require('./resolve');
const state = require('./state');
const start = require('./start');

const PRE_MATCHER = 'Edit|Write|MultiEdit|NotebookEdit';
const POST_MATCHER = 'Read|Grep|Glob|Bash';

function log(line) {
  process.stdout.write(line + '\n');
}

function isApHookCommand(cmd) {
  if (typeof cmd !== 'string') return false;
  const base = path.basename(cmd);
  // win32 ships ap-hook.exe (resolve.js's exeSuffix()) - strip it so the
  // idempotency check still recognizes our own entry on that platform.
  return base === 'ap-hook' || base === 'ap-hook.exe';
}

// Finds our own previously-installed matcher entry (matcher + an ap-hook
// command), not just any entry with the same matcher string — matcher
// strings are not unique keys in a real settings.json (see survey point 3).
function findOwnEntry(list, matcher) {
  for (const entry of list) {
    if (entry && entry.matcher === matcher && Array.isArray(entry.hooks)) {
      const hook = entry.hooks.find((h) => h && isApHookCommand(h.command));
      if (hook) return { entry, hook };
    }
  }
  return null;
}

// Mutates `settings` in place. Returns a list of human-readable change lines.
function mergeHooks(settings, apHookPath) {
  const changes = [];
  if (!settings.hooks || typeof settings.hooks !== 'object') settings.hooks = {};

  for (const [event, matcher] of [['PreToolUse', PRE_MATCHER], ['PostToolUse', POST_MATCHER]]) {
    if (!Array.isArray(settings.hooks[event])) settings.hooks[event] = [];
    const list = settings.hooks[event];
    const found = findOwnEntry(list, matcher);

    if (!found) {
      list.push({ matcher, hooks: [{ type: 'command', command: apHookPath }] });
      changes.push(`${event}: added ap-hook (${matcher})`);
      continue;
    }

    if (found.hook.command !== apHookPath) {
      const old = found.hook.command;
      found.hook.command = apHookPath;
      changes.push(`${event}: updated ap-hook path (${old} -> ${apHookPath})`);
    }
    // else: already correct, nothing to do — this is the "run twice" case.
  }

  return changes;
}

function wireHooks(printOnly) {
  const apHookPath = resolve.binaryOptional('ap-hook');
  const settingsPath = path.join(os.homedir(), '.claude', 'settings.json');

  if (!apHookPath) {
    log('ap-hook: not available on this platform — skipping hook wiring.');
    log('  Still works: relay/daemon/MCP tools (claim_work, respond, who_else_is_here).');
    log('  Not wired: arbitration on tool calls (that is what ap-hook does).');
    log('  Build it locally with:');
    log('    cmake -S cpp -B cpp/build && cmake --build cpp/build');
    return { wired: false, settingsPath };
  }

  let raw = null;
  if (fs.existsSync(settingsPath)) {
    raw = fs.readFileSync(settingsPath, 'utf8');
  }

  let settings;
  if (raw === null) {
    settings = {};
  } else if (raw.trim() === '') {
    settings = {};
  } else {
    try {
      settings = JSON.parse(raw);
    } catch (err) {
      throw new Error(
        `refusing to touch ${settingsPath}: it does not parse as JSON (${err.message}). ` +
          'Fix or remove it by hand, then rerun setup.'
      );
    }
  }

  const before = JSON.stringify(settings);
  const changes = mergeHooks(settings, apHookPath);
  const after = JSON.stringify(settings);

  if (before === after) {
    log(`hooks: already wired correctly in ${settingsPath}`);
    return { wired: true, settingsPath, changed: false };
  }

  for (const c of changes) log(`hooks: ${c}`);

  if (printOnly) {
    log(`(--print-only: not writing ${settingsPath})`);
    return { wired: true, settingsPath, changed: true, wouldWrite: settings };
  }

  if (raw !== null) {
    const backupPath = `${settingsPath}.bak-${Date.now()}`;
    fs.copyFileSync(settingsPath, backupPath);
    log(`backed up existing settings to ${backupPath}`);
  } else {
    fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
  }

  fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + '\n');
  log(`wrote ${settingsPath}`);
  return { wired: true, settingsPath, changed: true };
}

function claudeOnPath() {
  try {
    execFileSync('claude', ['--version'], { stdio: 'ignore' });
    return true;
  } catch (err) {
    return false;
  }
}

function mcpAlreadyRegistered() {
  try {
    const out = execFileSync('claude', ['mcp', 'list'], { encoding: 'utf8' });
    // Format per survey: "<name>: <command> - <status>". Match the name field only.
    return out.split('\n').some((line) => /^agent-presence:/.test(line.trim()));
  } catch (err) {
    // `claude mcp list` failing (e.g. no servers, or a non-zero exit some
    // versions use) shouldn't be treated as "already registered".
    return false;
  }
}

function registerMcp(printOnly, force) {
  if (!claudeOnPath()) {
    // bin/agent-presence.js is a sibling of lib/ in this same package.
    const binPath = path.join(__dirname, '..', 'bin', 'agent-presence.js');
    log('claude CLI not found on PATH — skipping MCP registration.');
    log('Run this yourself once claude is installed:');
    log(`  claude mcp add agent-presence --scope user -- node ${binPath} mcp`);
    return { registered: false };
  }

  if (!force && mcpAlreadyRegistered()) {
    log('mcp: agent-presence already registered');
    return { registered: true, changed: false };
  }

  // Register the shim subcommand ("node <bin/agent-presence.js> mcp"), not
  // the Go agent-presence-mcp binary directly. That is what makes
  // zero-config work: the shim checks server.json and starts a local relay
  // on loopback before exec'ing the real binary. Pointing Claude Code at the
  // Go binary directly would skip that and break the solo-user path.
  //
  // We resolve our own absolute bin path rather than relying on a global
  // `agent-presence` on PATH: a global npm bin dir isn't guaranteed to be on
  // PATH (nvm, corepack, `npx`-style installs), but this file's location
  // relative to bin/ always is correct. process.execPath pins the same node
  // that's running this script, in case `node` on PATH resolves elsewhere.
  const binPath = path.join(__dirname, '..', 'bin', 'agent-presence.js');
  const args = ['mcp', 'add', 'agent-presence', '--scope', 'user', '--', process.execPath, binPath, 'mcp'];

  if (printOnly) {
    log(`(--print-only: would run) claude ${args.join(' ')}`);
    return { registered: false, changed: true };
  }

  try {
    execFileSync('claude', args, { stdio: 'inherit' });
    log('mcp: registered agent-presence');
    return { registered: true, changed: true };
  } catch (err) {
    log(`mcp: registration failed — ${err.message}`);
    log(`Run by hand:  claude ${args.join(' ')}`);
    return { registered: false, changed: false, error: true };
  }
}

async function run(argv) {
  const printOnly = argv.includes('--print-only');
  const force = argv.includes('--force');

  log('agent-presence setup');
  log('');

  let hookResult;
  try {
    hookResult = wireHooks(printOnly);
  } catch (err) {
    log(String(err.message || err));
    return 1;
  }

  log('');
  const mcpResult = registerMcp(printOnly, force);

  log('');
  const cfg = safeReadConfig();
  const joined = !!(cfg && cfg.relay);

  let relayStarted = false;
  if (!printOnly && !joined) {
    log('starting relay...');
    try {
      const code = await start.run(['start']);
      relayStarted = code === 0 || code === undefined;
    } catch (err) {
      log(`relay start failed: ${err.message}`);
    }
  } else if (joined) {
    log(`this machine is joined to ${cfg.relay} — not starting a local relay.`);
  } else {
    log('(--print-only: not starting relay)');
  }

  log('');
  log('summary:');
  log(`  hooks:   ${hookResult.wired ? (hookResult.changed ? 'wired' : 'already wired') : 'skipped (no ap-hook on this platform)'}`);
  log(`  mcp:     ${mcpResult.registered ? 'registered' : 'not registered — see command above'}`);
  log(`  relay:   ${joined ? 'using joined relay' : relayStarted ? 'started' : printOnly ? 'not started (--print-only)' : 'not started'}`);
  log('');
  log('next: run `agent-presence invite` to get a join blob for a teammate,');
  log('      or `agent-presence doctor` if anything above looks off.');

  return 0;
}

function safeReadConfig() {
  try {
    return state.readConfig();
  } catch (err) {
    return null;
  }
}

module.exports = { run };
