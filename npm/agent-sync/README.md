# agent-sync

Multi-agent presence and coordination for Claude Code. One install, one command.

```
npm i -g agent-sync
agent-sync setup
```

That wires the hooks and MCP server into Claude Code and starts a relay on
localhost if nothing's running yet. If a teammate already has one going:

```
agent-sync join <blob from their 'agent-sync invite'>
```

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
