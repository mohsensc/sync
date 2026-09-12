// start/stop/status for the relay this machine manages.
//
// Shape: run(argv) dispatches on argv[0] ('start' | 'stop' | 'status',
// defaulting to 'start' for anything else) and returns an exit code, the
// same as doctor/setup/join's `run`. stop() and status() are also exported
// directly so bin.js can call them without going through the argv dance -
// use whichever reads better at the call site.

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const state = require('./state');
const resolve = require('./resolve');

const DEFAULT_PORT = 8799;
const START_TIMEOUT_MS = 5000;
const POLL_INTERVAL_MS = 100;
// Long enough for a healthy gorelay to drain and exit, short enough that a
// genuinely wedged one doesn't leave someone staring at a hung terminal.
const STOP_TIMEOUT_MS = 3000;
const LISTEN_RE = /relay listening on (\S+)/;

function pkgVersion() {
  try {
    return require('../package.json').version;
  } catch {
    return 'unknown';
  }
}

function wsScheme() {
  return process.env.AGENT_PRESENCE_TLS_CERT ? 'wss' : 'ws';
}

function splitHostPort(addr) {
  const idx = addr.lastIndexOf(':');
  if (idx === -1) return { host: addr, port: null };
  return { host: addr.slice(0, idx), port: Number(addr.slice(idx + 1)) };
}

// fromOffset for the same reason waitForListen takes one: on a failed start,
// showing the tail of a previous run's log sends someone chasing an error that
// already happened and was already fixed.
function tailLog(logFile, lines, fromOffset) {
  try {
    const content = fs.readFileSync(logFile, 'utf8').slice(fromOffset || 0);
    const all = content.split('\n').filter(Boolean);
    if (!all.length) return '(this run produced no log output)';
    return all.slice(-lines).join('\n');
  } catch {
    return '(no log output captured)';
  }
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// Polls the log file for gorelay's "relay listening on <addr>" line. Races
// against the child exiting early (bad flags, port stolen between our check
// and gorelay's bind, etc.) so a dead-on-arrival process doesn't just hang
// us for the full timeout.
// fromOffset is where this run's output starts. The log is opened in append
// mode so a crash's output survives, which means the file already holds every
// previous run's "relay listening on ..." line - scanning from byte 0 returns
// the address of a relay that is no longer running, and `start --host 0.0.0.0`
// cheerfully reports the 127.0.0.1 it replaced.
async function waitForListen(logFile, child, timeoutMs, fromOffset) {
  const deadline = Date.now() + timeoutMs;
  let exited = false;
  let exitInfo = null;
  child.once('exit', (code, signal) => {
    exited = true;
    exitInfo = { code, signal };
  });

  while (Date.now() < deadline) {
    let content = '';
    try {
      content = fs.readFileSync(logFile, 'utf8').slice(fromOffset);
    } catch {
      // log file not created yet
    }
    const m = content.match(LISTEN_RE);
    if (m) return { addr: m[1] };
    if (exited) return { exited: true, exitInfo };
    await sleep(POLL_INTERVAL_MS);
  }
  return { timedOut: true };
}

// Is something already listening on host:port that ISN'T a relay we know
// about (no live server.json for it)? Used to decide whether to fall back
// to --port 0 or to refuse and point the user at what's already there.
async function portTakenByOther(host, port) {
  return state.portOpen(host, port, 300);
}

// --host/--port on `start`, because `invite` tells a user to run
// `agent-presence start --host 0.0.0.0` when the relay is stuck on loopback.
// Reading only AGENT_PRESENCE_HOST would make that instruction silently do
// nothing, which is worse than not offering it.
function parseStartFlags(argv) {
  const out = { host: null, port: null };
  const rest = argv || [];
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (a === '--host') out.host = rest[++i];
    else if (a.startsWith('--host=')) out.host = a.slice(7);
    else if (a === '--port') out.port = rest[++i];
    else if (a.startsWith('--port=')) out.port = a.slice(7);
    else throw new Error(`agent-presence start: unknown option ${a}\nUsage: agent-presence start [--host HOST] [--port PORT]`);
  }
  if (out.port !== null && !/^\d+$/.test(out.port)) {
    throw new Error(`agent-presence start: --port must be a number, got ${out.port}`);
  }
  return out;
}

async function doStart(argv) {
  let flags;
  try {
    flags = parseStartFlags(argv);
  } catch (err) {
    console.error(err.message);
    return 1;
  }
  await state.ensureHomeDir();

  const existing = state.readServer();
  if (await state.isServerLive(existing)) {
    console.log(`agent-presence: already running at ${wsScheme()}://${existing.addr}`);
    console.log(`agent-presence invite   # to bring in a teammate`);
    return 0;
  }
  if (existing) {
    // Dead pid or closed port - stale state, clear it before deciding
    // anything else so it doesn't confuse the joined/port checks below.
    state.clearServer();
  }

  const config = state.readConfig();
  if (config && config.relay) {
    console.log(`agent-presence: this machine is joined to ${config.relay}`);
    console.log(`Not starting a local relay. Run 'agent-presence join' again to switch,`);
    console.log(`or edit ${state.configPath()} directly to leave.`);
    return 0;
  }

  let gorelayPath;
  try {
    gorelayPath = resolve.binary('gorelay');
  } catch (err) {
    console.error(err.message);
    return 1;
  }

  // Flag beats env beats default, the same precedence gorelay's own --port
  // has over AGENT_PRESENCE_PORT. An explicitly chosen port is never quietly
  // swapped for a free one below.
  const envPort = process.env.AGENT_PRESENCE_PORT;
  const explicitPort = flags.port ? Number(flags.port) : (envPort ? Number(envPort) : null);
  const desiredPort = explicitPort || DEFAULT_PORT;
  const host = flags.host || process.env.AGENT_PRESENCE_HOST || '127.0.0.1';

  const taken = await portTakenByOther(host, desiredPort);
  let portArg;
  if (taken) {
    if (explicitPort) {
      // The user asked for this exact port. Something is already there and
      // we have no record of starting it - don't guess, don't pick a
      // different port out from under them.
      console.error(
        `agent-presence: something is already listening on ${host}:${desiredPort}, ` +
        `and it's not a relay this machine started (no server.json for it).`
      );
      console.error(`Run 'agent-presence status' to check, or point AGENT_PRESENCE_RELAY at it directly.`);
      console.error(`Not starting a second relay on that port.`);
      return 1;
    }
    // Default port, taken by something we don't manage - fall back to a
    // free port rather than fail. gorelay resolves --port 0 itself and
    // logs the real bound address, which we read back below.
    portArg = '0';
  } else {
    portArg = String(desiredPort);
  }

  state.ensureHomeDir();
  const logFile = state.logPath();
  const logOffset = fs.existsSync(logFile) ? fs.statSync(logFile).size : 0;
  const logFd = fs.openSync(logFile, 'a');

  const child = spawn(gorelayPath, ['--host', host, '--port', portArg], {
    detached: true,
    stdio: ['ignore', logFd, logFd],
  });
  fs.closeSync(logFd);
  child.unref();

  const result = await waitForListen(logFile, child, START_TIMEOUT_MS, logOffset);

  if (result.addr) {
    const { host: boundHost, port: boundPort } = splitHostPort(result.addr);
    // url is written alongside addr, not derived by each reader: `invite`
    // has to know the scheme to hand a teammate a dialable URL, and only
    // this process knows whether gorelay came up with TLS. tlsCert rides
    // along so `invite` can embed the PEM instead of asking for it again.
    state.writeServer({
      pid: child.pid,
      addr: result.addr,
      url: `${wsScheme()}://${result.addr}`,
      host: boundHost,
      port: boundPort,
      tlsCert: process.env.AGENT_PRESENCE_TLS_CERT || null,
      started: Date.now(),
      version: pkgVersion(),
    });
    console.log(`agent-presence: relay listening on ${wsScheme()}://${result.addr}`);
    console.log(`agent-presence invite   # to bring in a teammate`);
    return 0;
  }

  if (result.exited) {
    console.error(`agent-presence: gorelay exited before it started listening ` +
      `(code=${result.exitInfo.code} signal=${result.exitInfo.signal}).`);
    console.error(`--- tail of ${logFile} ---`);
    console.error(tailLog(logFile, 20, logOffset));
    console.error(`Fix the problem above and run 'agent-presence start' again.`);
    return 1;
  }

  console.error(`agent-presence: gorelay didn't report a listening address within ${START_TIMEOUT_MS}ms.`);
  console.error(`--- tail of ${logFile} ---`);
  console.error(tailLog(logFile, 20, logOffset));
  console.error(`It may still be starting - check 'agent-presence status', or inspect ${logFile}.`);
  try { process.kill(child.pid, 'SIGTERM'); } catch { /* best effort */ }
  return 1;
}

async function stop(argv) {
  const server = state.readServer();
  if (!server) {
    console.log('agent-presence: no relay running (nothing started by this machine).');
    return 0;
  }
  if (!state.pidAlive(server.pid)) {
    console.log(`agent-presence: relay (pid ${server.pid}) was already stopped.`);
    state.clearServer();
    return 0;
  }
  try {
    process.kill(server.pid, 'SIGTERM');
  } catch (err) {
    console.error(`agent-presence: couldn't stop pid ${server.pid}: ${err.message}`);
    return 1;
  }

  // Wait for it to actually die before clearing state. Clearing immediately
  // reports success for a relay that is still up and still holding the port,
  // and then there's no server.json pointing at it: doctor goes blind, and
  // the next `start` finds the port taken by "something this machine didn't
  // start" and quietly lands somewhere else. Keeping the state file on a
  // failed stop is what lets both of them still see the process.
  const deadline = Date.now() + STOP_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (!state.pidAlive(server.pid)) break;
    await sleep(POLL_INTERVAL_MS);
  }

  if (state.pidAlive(server.pid)) {
    console.error(`agent-presence: sent SIGTERM to pid ${server.pid} but it is still running after ${STOP_TIMEOUT_MS / 1000}s.`);
    console.error(`Leaving ${state.serverPath()} in place so 'agent-presence status' still finds it.`);
    console.error(`If it stays wedged: kill -9 ${server.pid}, then 'agent-presence start'.`);
    return 1;
  }

  state.clearServer();
  console.log(`agent-presence: stopped relay (pid ${server.pid}, was at ${server.addr}).`);
  return 0;
}

async function status(argv) {
  const config = state.readConfig();
  const server = state.readServer();
  const live = await state.isServerLive(server);

  if (config && config.relay) {
    console.log(`joined: ${config.relay}`);
  } else {
    console.log('joined: no (this machine is not joined to another relay)');
  }

  if (live) {
    console.log(`local relay: running at ${wsScheme()}://${server.addr} (pid ${server.pid})`);
  } else if (server) {
    console.log(`local relay: not running (stale state from a previous run - server.json points at ${server.addr})`);
  } else {
    console.log('local relay: not running');
  }

  for (const name of ['presenced', 'agent-presence-mcp', 'gorelay']) {
    let binPath = null;
    try {
      binPath = resolve.binary(name);
    } catch {
      // leave null - reported below
    }
    if (!binPath) {
      console.log(`  ${name}: not available for this platform`);
      continue;
    }
    console.log(`  ${name}: ${binPath}`);
  }

  const hookPath = resolve.binaryOptional('ap-hook');
  console.log(`  ap-hook: ${hookPath ? hookPath : 'not shipped for this platform (see: agent-presence doctor)'}`);

  return 0;
}

async function run(argv) {
  const sub = (argv && argv[0]) || 'start';
  if (sub === 'stop') return stop(argv.slice(1));
  if (sub === 'status') return status(argv.slice(1));
  return doStart(argv.slice(1));
}

module.exports = { run, stop, status };
