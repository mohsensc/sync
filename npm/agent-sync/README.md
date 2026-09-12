# agent-sync

Multi-agent presence and coordination. Hook-enforced tool-call arbitration in
Claude Code today; an AGENTS.md instructions block for other coding agents to
follow voluntarily.

This package is not on the npm registry yet, so there is no `npm i -g
agent-sync` one-liner — that command would either fail or (worse) silently
install the wrong thing: `@agent-sync/cli` is a real, pre-existing package on
npm, but it's an unrelated project, not this one. The actual install is a
local build:

```
git clone https://github.com/mohsensc/sync
cd sync
scripts/build-npm-packages.sh --pack
# then the `npm i -g <wrapper>.tgz <platform>.tgz` line it prints
agent-sync setup
```

`agent-sync setup` wires the hooks and MCP server into Claude Code and starts
a relay on localhost if nothing's running yet. If a teammate already has one
going:

```
agent-sync join <blob from their 'agent-sync invite'>
```

If you're not on Claude Code, `agent-sync setup` still writes nothing for
your tool: no hook and no MCP server registration exist for anything else
today. See "Other coding agents" below.

## Commands

```
agent-sync setup     wire hooks + MCP into Claude Code, then start
agent-sync start     background relay, prints its address, exits
agent-sync stop      stop the relay this machine started
agent-sync status    what's running, where
agent-sync invite    print a join blob for a teammate
agent-sync join      point this machine at someone else's relay
agent-sync doctor    diagnose, with a next step per failure
```

`agent-sync mcp` is internal - it's what Claude Code spawns, not something
you run by hand.

## Other coding agents

`agent-sync setup` (hooks + `claude mcp add`) is Claude-Code-specific code -
see `lib/setup.js`. Nothing in this package registers a hook or an MCP
server for Codex, Grok, Gemini CLI, Muse, or anything else.

What does work the same everywhere: after `agent-sync join <blob>`, running
`agent-sync mcp` yourself starts the same MCP server Claude Code uses. If
your coding agent supports adding a custom MCP server, you can register it
that way; consult that agent's own docs for the registration step, since
each one is different and this package doesn't automate any of them.

The dashboard's setup-instructions picker (agentsync.studio) writes an
`AGENTS.md` section describing this as a voluntary convention - the agent
calls the coordination tools if it has them, nothing enforces it if it
doesn't. That's the honest ceiling for a coding agent this package hasn't
wired a hook for.

## How the install works

This package is a thin JS shim. The actual binaries (`gorelay`, `presenced`,
`agent-sync-mcp`, and the optional `ap-hook`) ship in per-platform
packages selected by npm through `optionalDependencies`, the same pattern
esbuild and swc use. No postinstall script downloads anything, so
`npm ci --ignore-scripts` still works.

`ap-hook` may be missing on some platforms - see `agent-sync doctor`.
Everything else (relay, daemon, MCP tools) works without it; you just lose
tool-call arbitration.

## What's not verified here

`npm i -g agent-sync` from the public registry hasn't been run - that
needs a publish, which is out of scope for this change. What's been checked
is `npm pack` into tarballs and installing from those locally.
