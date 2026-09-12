'use strict';

// API notes (state.js is owned by another agent):
//   lib/state.js: homeDir() -> ~/.agent-sync, configPath() -> that dir's
//                 config.json, readServer()/readConfig() -> parsed JSON or
//                 null, writeConfig(o) (writes 0600 itself - this file's
//                 own chmod after the write is a belt-and-suspenders no-op).
//   server.json shape (written by start.js): { host, port, url, pid,
//                 tlsCert? (path to PEM, if the relay was started with TLS) }
//
// Per the binaries survey: there is no TLS fingerprint pinning anywhere in
// this codebase (AGENT_SYNC_RELAY_CA only takes a PEM file/bundle path,
// verified via full chain, not a leaf hash). So the join blob carries the
// whole cert PEM, not a fingerprint, and `join` writes it to a file that
// AGENT_SYNC_RELAY_CA can point at. This deviates from install-plan.md's
// "pins the fingerprint" language on purpose — that mechanism doesn't exist
// in the code being wrapped.

const fs = require('fs');
const os = require('os');
const net = require('net');
const path = require('path');

const state = require('./state');

const BLOB_VERSION = 1;
const CONNECT_TIMEOUT_MS = 4000;

function log(line) {
  process.stdout.write(line + '\n');
}
function err(line) {
  process.stderr.write(line + '\n');
}

function b64urlEncode(str) {
  return Buffer.from(str, 'utf8').toString('base64url');
}
function b64urlDecode(str) {
  return Buffer.from(str, 'base64url').toString('utf8');
}

function isPrivateOrLoopback(addr) {
  return (
    addr === '127.0.0.1' ||
    addr === '::1' ||
    addr === 'localhost' ||
    addr === '0.0.0.0' ||
    addr === '::'
  );
}

// Best-effort LAN IPv4 address: first non-internal IPv4 interface.
function lanAddress() {
  const ifaces = os.networkInterfaces();
  for (const name of Object.keys(ifaces)) {
    for (const iface of ifaces[name] || []) {
      if (iface.family === 'IPv4' && !iface.internal) return iface.address;
    }
  }
  return null;
}

function parseRelayUrl(url) {
  // ws://host:port or wss://host:port — new URL() handles both fine since
  // it doesn't special-case the scheme beyond parsing.
  const u = new URL(url);
  const port = u.port ? Number(u.port) : u.protocol === 'wss:' ? 443 : 80;
  return { scheme: u.protocol.replace(':', ''), host: u.hostname, port };
}

function readTokenFile() {
  if (process.env.AGENT_SYNC_TOKEN) return process.env.AGENT_SYNC_TOKEN.trim();
  const base = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config');
  const tokenPath = path.join(base, 'agent-sync', 'token');
  try {
    const text = fs.readFileSync(tokenPath, 'utf8');
    const firstLine = text.split('\n').find((l) => l.trim() !== '');
    return firstLine ? firstLine.trim() : null;
  } catch (e) {
    return null;
  }
}

function cmdInvite() {
  const server = safeReadServer();
  if (!server || !server.url) {
    err('no relay is running on this machine (no server.json). Run `agent-sync start` or `setup` first.');
    return 1;
  }

  const { scheme, host, port } = parseRelayUrl(server.url);
  let inviteHost = host;

  // gorelay reports a wildcard bind as "[::]" and new URL() keeps the
  // brackets, so an unnormalized '::' comparison never fires and the invite
  // goes out carrying ws://[::]:8799 - which no teammate can dial.
  const bare = host.replace(/^\[|\]$/g, '');
  if (bare === '0.0.0.0' || bare === '::' || bare === '') {
    const lan = lanAddress();
    if (!lan) {
      err('relay is bound to 0.0.0.0 but no LAN address could be found on this machine.');
      err('pass the reachable address to your teammate manually.');
      return 1;
    }
    inviteHost = lan;
  } else if (isPrivateOrLoopback(bare)) {
    log('');
    log('WARNING: the relay is bound to a loopback address (' + host + ').');
    log('A teammate on another machine cannot reach this. Restart the relay with:');
    log('  agent-sync stop && agent-sync start --host 0.0.0.0');
    log('  (or set AGENT_SYNC_HOST=0.0.0.0)');
    log('(for wss://, see docs/tls-dev-cert.md)');
    log('');
    log('Printing the invite anyway, but it will only work from this machine.');
    log('');
  }

  const blob = { v: BLOB_VERSION, relay: `${scheme}://${inviteHost}:${port}` };

  // The invite carries the inviter's own bearer token, so the teammate
  // authenticates as the same principal. Per the survey that's fine - a
  // token only picks a priority tier, it isn't a security boundary - but
  // it does mean this is not per-machine identity.
  const token = readTokenFile();
  if (token) blob.token = token;

  if (server.tlsCert) {
    try {
      blob.ca = fs.readFileSync(server.tlsCert, 'utf8');
    } catch (e) {
      err(`warning: relay reports a TLS cert at ${server.tlsCert} but it could not be read: ${e.message}`);
    }
  }

  const encoded = b64urlEncode(JSON.stringify(blob));
  log('agent-sync join ' + encoded);
  return 0;
}

function decodeBlob(raw) {
  let json;
  try {
    json = b64urlDecode(raw);
  } catch (e) {
    throw new Error('that does not look like a valid invite blob (not base64url).');
  }
  let blob;
  try {
    blob = JSON.parse(json);
  } catch (e) {
    throw new Error('that does not look like a valid invite blob (not JSON once decoded).');
  }
  if (!blob || typeof blob !== 'object') {
    throw new Error('invite blob decoded to something other than an object.');
  }
  if (blob.v !== BLOB_VERSION) {
    throw new Error(`invite blob has version ${blob.v}, this agent-sync only understands v${BLOB_VERSION}.`);
  }
  if (typeof blob.relay !== 'string' || !/^wss?:\/\//.test(blob.relay)) {
    throw new Error(`invite blob's relay field is not a ws:// or wss:// URL: ${JSON.stringify(blob.relay)}`);
  }
  return blob;
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

async function cmdJoin(blobArg) {
  if (!blobArg) {
    err('usage: agent-sync join <blob>');
    return 1;
  }

  let blob;
  try {
    blob = decodeBlob(blobArg);
  } catch (e) {
    err(`invalid invite blob: ${e.message}`);
    return 1;
  }

  const homeDir = state.homeDir();
  fs.mkdirSync(homeDir, { recursive: true });

  const config = { v: BLOB_VERSION, relay: blob.relay };
  if (blob.token) config.token = blob.token;

  if (blob.ca) {
    const caPath = path.join(homeDir, 'relay-ca.pem');
    fs.writeFileSync(caPath, blob.ca, { mode: 0o600 });
    try {
      fs.chmodSync(caPath, 0o600);
    } catch (e) {
      /* best effort on platforms without POSIX perms */
    }
    config.relayCa = caPath;
    log(`wrote CA cert to ${caPath}`);
  }

  state.writeConfig(config);
  const configPath = state.configPath();
  try {
    fs.chmodSync(configPath, 0o600);
  } catch (e) {
    /* best effort */
  }
  log(`wrote ${configPath}`);

  const { host, port } = parseRelayUrl(blob.relay);
  log(`testing connection to ${host}:${port}...`);
  const result = await testConnection(host, port);

  if (result.ok) {
    log('ok: reached the relay.');
    return 0;
  }

  err(`could not reach ${host}:${port} — ${result.reason}`);
  err('config was written anyway; run `agent-sync doctor` for more detail. Next steps:');
  err('  - is a firewall blocking the port?');
  err('  - did the other machine start the relay with --host 0.0.0.0 (not the default 127.0.0.1)?');
  err('  - is the host/port in the invite actually correct (NAT, VPN, wrong interface)?');
  return 1;
}

function safeReadServer() {
  try {
    return state.readServer();
  } catch (e) {
    return null;
  }
}

// Handles both plausible dispatch conventions from bin/agent-sync.js:
// either it forwards the full argv including the subcommand name ('invite'
// or 'join <blob>'), or it already consumed the subcommand and calls this
// module once per verb with just the remaining args. 'invite' takes no
// positional argument and 'join' takes exactly one, so the two cases don't
// collide.
async function run(argv) {
  const [first, second] = argv;
  if (first === 'invite') return cmdInvite();
  if (first === 'join') return cmdJoin(second);
  if (argv.length === 0) return cmdInvite();
  return cmdJoin(first);
}

module.exports = { run };
