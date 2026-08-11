# Agent Presence

A team's coding agents can't see each other in a shared repo, so they duplicate
work and clobber edits. One stream: ambient for humans, claims for agents.

`ap-hook` (C++) sits on Claude Code's tool calls, `presenced` (Go) coalesces
and snapshots, `agent-presence-mcp` (Go) is the
`claim_work`/`respond`/`who_else_is_here` surface. 90s lease TTL: a dead agent
never wedges a teammate.

## Run it

Three binaries, no Python needed on a teammate's machine:

```
cmake -S cpp -B cpp/build && cmake --build cpp/build   # ap-hook
./install.sh                                           # builds+installs all three, prints hooks
claude mcp add agent-presence -- ~/.local/bin/agent-presence-mcp
```

Both Go binaries derive room/agent/human from the repo and dial
`AGENT_PRESENCE_RELAY` (`ws://127.0.0.1:8799` by default), still Python:

```
cd python && python3 -m venv .venv && .venv/bin/pip install -e '.[dev]'
python/.venv/bin/agent-presence-relay   # --host/--port/--log-level or AGENT_PRESENCE_*
```

There's also a Go relay (`go/cmd/gorelay`), opt-in, faster under contention:
build it, `agent-presence-relay --impl go` execs it (`docs/relay-parity.md`).
`--tls-cert`/`--tls-key` (`docs/tls-dev-cert.md`) get `wss://` on the Python
relay only, gorelay has no TLS yet.

## Policy

A TOML file sets how loudly a collision gets told; `ap` is the verb surface
over it (`ap policy show --effective`, `ap policy set rung3=ask`, `ap why -n
20`, `ap doctor`), applied live, no restart. MCP stays read-only,
`$AGENT_PRESENCE_UNATTENDED` promotes `ask` to `deny`, and
`.agent-presence/principals.toml` ranks who outranks whom.

Tests: `cd python && .venv/bin/python -m pytest`; `cmake --build cpp/build &&
ctest --test-dir cpp/build`; `cd go && go test ./... -race -count=1`; `cd web
&& pnpm test && pnpm typecheck`.

## What's broken

Ladder tuning is guesswork, only run against scripted clients so far. `ap
policy compile` puts `[[path]]` rules in the cache, but the daemon still reads
only the blanket table. Rung 4 is off unless `AGENT_PRESENCE_RUNG4=1`, and
its embedding backend loses to lexical (`embedding_similarity.py`).
