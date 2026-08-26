# Agent Presence

A team's coding agents can't see each other in a shared repo, so they duplicate
work and clobber edits. One stream: ambient for humans, claims for agents.

Four binaries: `ap-hook` (C++) sits on Claude Code's tool calls, `presenced`
(Go) coalesces and snapshots, `agent-presence-mcp` (Go) is the
`claim_work`/`respond`/`who_else_is_here` surface, `gorelay` (Go) is the
relay — leases, wait-die, the ladder, negotiation, fan-out, the org policy
floor. 90s lease TTL: a dead agent never wedges a teammate.

## Run it

Not on the npm registry yet — ships from tagged releases; for now, build the
tarball with `scripts/build-npm-packages.sh --pack` and install it.
```
npm i -g agent-presence
agent-presence setup
```

Joining instead of starting your own relay (blob from `agent-presence invite`):
```
npm i -g agent-presence
agent-presence join <blob>
```

Paste into your agent to get set up:
> Install agent-presence for me using `npm i -g agent-presence`, then run
> `agent-presence setup`. It self-registers with Claude Code.

Packaging and self-registration details: `docs/install-plan.md`.

## Policy

A TOML file sets how loudly a collision gets told; `ap` (Python) is the verb
surface over it (`ap policy show --effective`, `ap policy set rung3=ask`,
`ap why -n 20`, `ap doctor`), applied live, no restart. The relay carries an
org-wide floor the same way; MCP stays read-only.

Tests: `scripts/ci-local.sh` runs all five suites and checks every exit code
— no CI does this for you any more, run it before finalizing a PR. More on
ports, TLS, and metrics: `docs/`.

## What's broken

Ladder tuning is guesswork, only run against scripted clients so far. Rung 4
is off unless `AGENT_PRESENCE_RUNG4=1`, its scorer is a placeholder (#15), and
`ap policy set rung4=...` is a no-op — the relay resolves that rung against
the builtin and org layers only, so changing it takes an org file.
