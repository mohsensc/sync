# Agent Presence

A few people on a team run coding agents against the same repo. The agents can't
see each other, so they duplicate work and overwrite each other and you find out
at merge time. One event stream: ambient for humans, claims for agents.

`ap-hook` is a C++ binary on Claude Code's tool calls — observe, write to a unix
socket, exit. `presenced` (Go) coalesces and snapshots; the Python relay owns
leases and arbitration. Leases expire in 90s, so a dead agent never wedges a
teammate. The hook stays C++ (a Go hook misses the 5ms budget, see
docs/gohook-spike.md); the daemon doesn't need that speed and ports cleanly.

## Run it

```
cd python && python3 -m venv .venv && .venv/bin/pip install -e '.[dev]' && cd ..
python/.venv/bin/agent-presence-relay              # 127.0.0.1:8799
claude mcp add agent-presence -- "$PWD/python/.venv/bin/agent-presence-mcp"
cmake -S cpp -B cpp/build && cmake --build cpp/build   # ap-hook
./install.sh                                       # builds presenced, prints hooks
```

There's also a Go relay (`go/cmd/gorelay`), same wire protocol, faster under
contention. Opt-in: `cd go && go build -o bin/gorelay ./cmd/gorelay`, then
`agent-presence-relay --impl go`. See `docs/relay-parity.md` for what's
verified and what isn't yet — the default is still the Python relay.

The relay takes `--host`/`--port`/`--log-level` or `AGENT_PRESENCE_*`; port 0
picks a free one. MCP and `presenced` derive room/agent/human from the repo.

## Policy

How loudly a collision gets told is a TOML file and `ap` is the verb surface
over it. Saved is applied, nothing restarts. MCP stays read-only.

```
ap policy show --effective     # what's in force, and which file said so
ap policy set rung3=ask        # writes the TOML, then recompiles the cache
ap why -n 20                   # the last decisions and why they went that way
ap doctor                      # is any of this actually reaching the daemon
```

`$AGENT_PRESENCE_UNATTENDED` promotes `ask` to `deny`. Who outranks whom is
`.agent-presence/principals.toml`, committed so it's reviewed in a PR;
`presenced` presents the token on join.

Tests: `cd python && .venv/bin/python -m pytest`; `cmake --build cpp/build &&
ctest --test-dir cpp/build`; `cd go && go test ./... -race -count=1`; `cd web &&
pnpm test && pnpm typecheck`. Bare `pytest` won't do. Not `npx`. CI runs all four.

## What's broken

Ladder tuning is guesswork, run only against scripted clients so far. `ap
policy compile` puts `[[path]]` rules in the cache; the daemon still reads only
the blanket table. Rung 4 is off unless `AGENT_PRESENCE_RUNG4=1`.
