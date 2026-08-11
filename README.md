# Agent Presence

A team's coding agents can't see each other in a shared repo, so they duplicate
work and clobber edits. One stream: ambient for humans, claims for agents.

`ap-hook` (C++) sits on Claude Code's tool calls, `presenced` (Go) coalesces
and snapshots, `agent-presence-mcp` (Go) is the
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

Everything dials `AGENT_PRESENCE_RELAY` (`ws://127.0.0.1:8799` by default).
`--tls-cert`/`--tls-key` (or `AGENT_PRESENCE_TLS_CERT`/`_KEY`, see
`docs/tls-dev-cert.md`) terminate `wss://` instead; unset is still the
zero-config `ws://` default.

## Policy

A TOML file sets how loudly a collision gets told; `ap` (Python) is the verb
surface over it (`ap policy show --effective`, `ap policy set rung3=ask`,
`ap why -n 20`, `ap doctor`), applied live, no restart. The relay carries an
org-wide floor the same way (`AGENT_PRESENCE_ORG_POLICY`). MCP stays
read-only, `$AGENT_PRESENCE_UNATTENDED` promotes `ask` to `deny`, and
`.agent-presence/principals.toml` ranks who outranks whom.

Tests: `cd go && go test ./... -race -count=1`; `cd python && python3 -m venv
.venv && .venv/bin/pip install -e '.[dev]' && .venv/bin/python -m pytest`
(builds `gorelay` on demand for the black-box suite); `cmake --build
cpp/build && ctest --test-dir cpp/build`; `cd web && pnpm test && pnpm
typecheck`.

## What's broken

Ladder tuning is guesswork, only run against scripted clients so far. `ap
policy compile` puts `[[path]]` rules in the cache, but the daemon still reads
only the blanket table. Rung 4 is off unless `AGENT_PRESENCE_RUNG4=1`, and
its lexical scorer is a placeholder (#15).
