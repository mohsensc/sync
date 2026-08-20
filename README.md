# Agent Presence

A team's coding agents can't see each other in a shared repo, so they duplicate
work and clobber edits. One stream: ambient for humans, claims for agents.

`ap-hook` (C++) sits on Claude Code's tool calls, `presenced` (Go) coalesces and snapshots, `agent-presence-mcp` (Go) is the
`claim_work`/`respond`/`who_else_is_here` surface, `gorelay` (Go) is the
relay: leases, wait-die, the ladder, negotiation, fan-out, the org policy
floor. 90s lease TTL: a dead agent never wedges a teammate.

## Run it

Four binaries, no Python needed on a teammate's machine:

```
cmake -S cpp -B cpp/build && cmake --build cpp/build   # ap-hook
./install.sh                                           # builds+installs, prints hooks
claude mcp add agent-presence -- ~/.local/bin/agent-presence-mcp
~/.local/bin/gorelay                                    # or --host/--port, AGENT_PRESENCE_*
```

`install.sh` prefers `dist/` when it's populated, but rebuilds from source if
`go/` looks newer and Go is on PATH, or installs the stale binary with a loud
warning if it isn't; with neither Go nor a populated `dist/` it fails, and
there's no download step — fetch from a tagged release yourself. Everything dials `AGENT_PRESENCE_RELAY`
(`ws://127.0.0.1:8799` by default), and `--tls-cert`/`--tls-key` (or `AGENT_PRESENCE_TLS_CERT`/`_KEY`, see `docs/tls-dev-cert.md`) terminate `wss://` instead; unset stays `ws://`.

## Policy

A TOML file sets how loudly a collision gets told; `ap` (Python) is the verb
surface over it (`ap policy show --effective`, `ap policy set rung3=ask`,
`ap why -n 20`, `ap doctor`), applied live, no restart. The relay carries an
org-wide floor the same way (`AGENT_PRESENCE_ORG_POLICY`). MCP stays
read-only, `$AGENT_PRESENCE_UNATTENDED` promotes `ask` to `deny`, and `.agent-presence/principals.toml` ranks who outranks whom.

Tests: `scripts/ci-local.sh` runs all five suites and checks every exit code
— no CI does this for you any more, so run it before finalising a PR. One
suite at a time: `scripts/ci-local.sh go` (or `python`/`cpp`/`web`/`ops`), or
straight to the tool — `go test ./... -race -count=1`, `pytest` (from a venv with `.[dev]` installed), `ctest --test-dir cpp/build`, `pnpm test`.

## Monitoring

`gorelay --metrics-addr=host:port` serves `/metrics` (unset by default) — daemons push stats over that connection instead of exposing their own; see `docs/monitoring.md`.

## What's broken

Ladder tuning is guesswork, only run against scripted clients so far. Rung 4
is off unless `AGENT_PRESENCE_RUNG4=1`, its scorer is a placeholder (#15), and
`ap policy set rung4=...` is a no-op — the relay resolves that rung against
the builtin and org layers only, so changing it takes an org file.
