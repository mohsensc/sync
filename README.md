# Agent Sync

A team's coding agents can't see each other in a shared repo, so they
duplicate work and clobber edits. One stream: ambient for humans, claims for
agents — seen either as a live 3D office (one clay-mesh character per agent,
high-fiving a clean handoff, squaring off on an actual collision) or a plain
hosted dashboard.

Four binaries: `ap-hook` (C++) sits on Claude Code's tool calls, `presenced`
(Go) coalesces and snapshots, `agent-sync-mcp` (Go) is the
`claim_work`/`respond`/`who_else_is_here` surface, `gorelay` (Go) is the
relay — leases, wait-die, the ladder, negotiation, fan-out, the org policy
floor. 90s lease TTL: a dead agent never wedges a teammate.

Three.js runs the office scene, Vite/pnpm builds it, Vitest tests it. The
hosted dashboard is Vercel serverless (`api/`) over Neon Postgres, Clerk for
auth. `agent-sync-mcp` is a real MCP server — it just runs on your machine,
not theirs.

## Run it

**Hosted, no setup:** agentsync.studio — sign in, see your own account's
agents on the live dashboard.

**Demo, no install:** `cd web && pnpm install && pnpm dev`, then open
`http://127.0.0.1:5173/src/office/office.html` (needs Node, pnpm, and Go on
PATH — dev proxy is Go). No relay/daemon/hook needed, scripted demo off the
clone's own git history.

**For real:** not on the npm registry yet — ships from tagged releases.
Build, pack, then install the two tarballs the script prints:
```
scripts/build-npm-packages.sh --pack
# then the `npm i -g <wrapper>.tgz <platform>.tgz` line it prints
agent-sync setup
```
`setup` writes `~/.claude/settings.json` (the hook) and registers the MCP
server via `claude mcp add` directly, no confirm or undo yet (#212). Joining
instead: `agent-sync join <blob>` (blob comes from `agent-sync invite`).

Other coding agents (Codex, Grok, Gemini CLI, Muse) get the same local build
above plus an AGENTS.md/CLAUDE.md section from the hosted setup picker — an
instruction the connecting agent follows if it chooses to, not code this repo
runs. Only Claude Code gets the real hook + MCP wiring (see
`api/_lib/tokens.ts`'s `setupInstructions`). Packaging and self-registration:
`docs/install-plan.md`.

## Policy

A TOML file sets how loudly a collision gets told; `ap` (Python) is the verb
surface over it (`ap policy show --effective`, `ap policy set rung3=ask`,
`ap why -n 20`, `ap doctor`), applied live, no restart. The relay carries an
org-wide floor the same way; MCP stays read-only. Tests:
`scripts/ci-local.sh` runs all five suites and checks every exit code — no CI
does this for you any more, run it before finalizing a PR. More on ports,
TLS, and metrics: `docs/`.

## What's broken

Ladder tuning is guesswork, only run against scripted clients so far. Rung 4
is off unless `AGENT_SYNC_RUNG4=1`, its scorer is a placeholder (#15), and
`ap policy set rung4=...` is a no-op — the relay resolves that rung against
the builtin and org layers only, so changing it takes an org file.
