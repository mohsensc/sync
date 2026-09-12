// ~/.agent-presence/ state: server.json (what this machine started, if
// anything) and config.json (what relay this machine is joined to, if any).
// AGENT_PRESENCE_HOME overrides the base dir - mainly for tests, so we don't
// have to touch the real home directory to exercise this.

const fs = require('fs');
const path = require('path');
const net = require('net');
const os = require('os');

function homeDir() {
  return process.env.AGENT_PRESENCE_HOME || path.join(os.homedir(), '.agent-presence');
}

function ensureHomeDir() {
  const dir = homeDir();
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function serverPath() {
  return path.join(homeDir(), 'server.json');
}

function configPath() {
  return path.join(homeDir(), 'config.json');
}

function logPath() {
  return path.join(homeDir(), 'relay.log');
}

function readJson(p) {
  try {
    const raw = fs.readFileSync(p, 'utf8');
    return JSON.parse(raw);
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    // Corrupt/unreadable state file - treat as absent rather than crashing
    // the whole CLI over a stray byte in a JSON file we own.
    return null;
  }
}

function writeJsonAtomic(p, obj, mode) {
  ensureHomeDir();
  const tmp = p + '.tmp.' + process.pid;
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2) + '\n', { mode: mode || 0o644 });
  fs.renameSync(tmp, p);
  if (mode) fs.chmodSync(p, mode);
}

function readServer() {
  return readJson(serverPath());
}

// { pid, addr, port, host, started, version }
function writeServer(server) {
  writeJsonAtomic(serverPath(), server);
}

function clearServer() {
  try {
    fs.unlinkSync(serverPath());
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }
}

function readConfig() {
  return readJson(configPath());
}

// { relay, relayCa, token } - written 0600 because it holds a bearer token.
// relayCa mirrors AGENT_PRESENCE_RELAY_CA: a PEM path (or, once join.js
// pins a fingerprint at join time, whatever it ends up storing there).
function writeConfig(config) {
  writeJsonAtomic(configPath(), config, 0o600);
}

function clearConfig() {
  try {
    fs.unlinkSync(configPath());
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }
}

function pidAlive(pid) {
  if (!pid) return false;
  try {
    // Signal 0: no-op, just checks the pid exists and is ours to signal.
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === 'EPERM'; // exists, owned by someone else - still alive
  }
}

// Checks that `port` on `host` is actually accepting TCP connections. A
// killed process can leave a server.json behind that still names a real
// pid (recycled by the OS to something unrelated) or a port nothing is
// listening on anymore - liveness needs both checks, not just the pid.
function portOpen(host, port, timeoutMs) {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    let done = false;
    const finish = (ok) => {
      if (done) return;
      done = true;
      socket.destroy();
      resolve(ok);
    };
    socket.setTimeout(timeoutMs || 500);
    socket.once('connect', () => finish(true));
    socket.once('timeout', () => finish(false));
    socket.once('error', () => finish(false));
    socket.connect(port, host || '127.0.0.1');
  });
}

// True only if server.json exists, its pid is alive, AND its port is
// actually accepting connections. Any of those failing means "not running"
// - a stale server.json from a killed process must read as not-running.
async function isServerLive(server) {
  if (!server || !server.pid || !server.port) return false;
  if (!pidAlive(server.pid)) return false;
  return portOpen(server.host || '127.0.0.1', server.port);
}

module.exports = {
  homeDir,
  ensureHomeDir,
  serverPath,
  configPath,
  logPath,
  readServer,
  writeServer,
  clearServer,
  readConfig,
  writeConfig,
  clearConfig,
  pidAlive,
  portOpen,
  isServerLive,
};
