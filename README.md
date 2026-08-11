# Agent Presence

A few people on a team run coding agents against the same repo. The agents can't
see each other, so they duplicate work and overwrite each other and you find out
at merge time. One event stream: ambient for humans, claims for agents.

`ap-hook` (C++) sits on Claude Code's tool calls. `presenced` (Go) coalesces
and snapshots. `agent-presence-mcp` (Go) is the `claim_work`/`respond`/
`who_else_is_here` tool surface. The Python relay owns leases and arbitration;
leases expire in 90s, so a dead agent never wedges a teammate.

## Run it

Three binaries, no Python needed on a teammate's machine:

```
cmake -S cpp -B cpp/build && cmake --build cpp/build   # ap-hook
./install.sh                                           # builds+installs all three, prints hooks
claude mcp add agent-presence -- ~/.local/bin/agent-presence-mcp
```

Both Go binaries derive room/agent/human from the repo and point at
`AGENT_PRESENCE_RELAY` (default `ws://127.0.0.1:8799`). The relay itself is
still Python — one person's server, not every teammate's machine:

```
cd python && python3 -m venv .venv && .venv/bin/pip install -e '.[dev]'
python/.venv/bin/agent-presence-relay   # --host/--port/--log-level or AGENT_PRESENCE_*
```

## Policy

How loudly a collision gets told is a TOML file and `ap` is the verb surface
over it (`ap policy show --effective`, `ap policy set rung3=ask`, `ap why -n
20`, `ap doctor`). Saved is applied, nothing restarts. MCP stays read-only.
`$AGENT_PRESENCE_UNATTENDED` promotes `ask` to `deny`. Who outranks whom is
`.agent-presence/principals.toml`, committed so it's reviewed in a PR.

Tests: `cd python && .venv/bin/python -m pytest`; `cmake --build cpp/build &&
ctest --test-dir cpp/build`; `cd go && go test ./... -race -count=1`; `cd web &&
pnpm test && pnpm typecheck`. Bare `pytest` won't do. Not `npx`. CI runs all four.

## What's broken

Ladder tuning is guesswork, run only against scripted clients so far. `ap
policy compile` puts `[[path]]` rules in the cache; the daemon still reads only
the blanket table. Rung 4 is off unless `AGENT_PRESENCE_RUNG4=1`.
