#!/usr/bin/env node
// Single entrypoint, dispatches to lib/*.js by subcommand. Every module
// contract is the same: module.exports.run(argv) => Promise<number exit code>.
// doctor.js, setup.js and join.js are owned elsewhere and required by this
// exact contract - don't inline their logic here.
//
// 'invite' isn't a file in this agent's scope. It's the inverse of 'join'
// (mint a blob vs consume one) so it's dispatched to lib/join.js's run()
// with argv[0] === 'invite', the same argv[0]-dispatch convention
// lib/start.js uses for start/stop/status. If join.js turns out not to
// switch on argv[0], this needs a one-line fix here, not a redesign.

const USAGE = `agent-sync - multi-agent presence and coordination
  (hook-enforced in Claude Code; AGENTS.md-only elsewhere - see README)

Usage:
  agent-sync setup            wire hooks + MCP into Claude Code, then start
  agent-sync start            background relay, prints its address, exits
  agent-sync stop             stop the relay this machine started
  agent-sync status           what's running, where
  agent-sync invite           print a join blob for a teammate
  agent-sync join <blob>      point this machine at someone else's relay
  agent-sync doctor           diagnose, with a next step per failure
  agent-sync mcp              internal: what Claude Code spawns
  agent-sync --version        print the CLI version
  agent-sync help             this message
`;

function checkNodeVersion() {
  const major = Number(process.versions.node.split('.')[0]);
  if (major < 18) {
    console.error(
      `agent-sync needs Node 18 or newer (found ${process.version}).\n` +
      `Install a current Node - e.g. https://nodejs.org, or via nvm/fnm/volta -\n` +
      `and re-run this command.`
    );
    process.exit(1);
  }
}

async function runMcp() {
  // stdout is the MCP stdio transport from the moment agent-sync-mcp
  // takes over. Nothing before that exec may touch stdout either - so any
  // console.log calls made by lib/start.js while we bring up a local relay
  // get redirected to stderr for the duration of this command.
  const state = require('../lib/state');
  const resolve = require('../lib/resolve');
  const start = require('../lib/start');
  const { spawn } = require('child_process');

  const originalLog = console.log;
  console.log = (...args) => console.error(...args);

  let relayUrl;
  let extraEnv = {};
  try {
    const config = state.readConfig();
    if (config && config.relay) {
      relayUrl = config.relay;
      if (config.token) extraEnv.AGENT_SYNC_TOKEN = config.token;
      if (config.relayCa) extraEnv.AGENT_SYNC_RELAY_CA = config.relayCa;
    } else {
      let server = state.readServer();
      if (!(await state.isServerLive(server))) {
        const code = await start.run(['start']);
        if (code !== 0) {
          console.error('agent-sync mcp: could not bring up a local relay, see above.');
          return code;
        }
        server = state.readServer();
      }
      if (!server) {
        console.error('agent-sync mcp: relay start reported success but left no server.json.');
        return 1;
      }
      relayUrl = `ws://${server.addr}`;
    }
  } finally {
    console.log = originalLog;
  }

  let mcpPath;
  try {
    mcpPath = resolve.binary('agent-sync-mcp');
  } catch (err) {
    console.error(err.message);
    return 1;
  }

  const child = spawn(mcpPath, [], {
    stdio: 'inherit',
    env: Object.assign({}, process.env, { AGENT_SYNC_RELAY: relayUrl }, extraEnv),
  });

  const forward = (sig) => { try { child.kill(sig); } catch { /* already gone */ } };
  process.on('SIGINT', () => forward('SIGINT'));
  process.on('SIGTERM', () => forward('SIGTERM'));

  return new Promise((res) => {
    child.on('exit', (code, signal) => {
      res(signal ? 1 : (code == null ? 1 : code));
    });
    child.on('error', (err) => {
      console.error(`agent-sync mcp: failed to launch agent-sync-mcp: ${err.message}`);
      res(1);
    });
  });
}

async function dispatch(argv) {
  const [cmd, ...rest] = argv;

  switch (cmd) {
    case undefined:
    case 'help':
    case '-h':
    case '--help':
      process.stdout.write(USAGE);
      return 0;

    case '--version':
    case '-v':
      console.log(require('../package.json').version);
      return 0;

    case 'start':
    case 'stop':
    case 'status':
      return require('../lib/start').run([cmd, ...rest]);

    case 'setup':
      return require('../lib/setup').run(rest);

    case 'join':
      return require('../lib/join').run(['join', ...rest]);

    case 'invite':
      return require('../lib/join').run(['invite', ...rest]);

    case 'doctor':
      return require('../lib/doctor').run(rest);

    case 'mcp':
      return runMcp();

    default:
      process.stderr.write(`agent-sync: unknown command '${cmd}'\n\n`);
      process.stderr.write(USAGE);
      return 1;
  }
}

async function main() {
  checkNodeVersion();
  const code = await dispatch(process.argv.slice(2));
  process.exit(code);
}

main().catch((err) => {
  // Plain message, no stack - this is a CLI, not a stack trace dump.
  console.error(`agent-sync: ${err && err.message ? err.message : err}`);
  process.exit(1);
});
