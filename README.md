# Agent Presence

A few people on a team each run coding agents against the same repo. Nobody can
see what the agents are doing and the agents can't see each other, so they
duplicate work and overwrite each other, and you find out at merge time. One
event stream, two readers: an ambient world for humans, claims for agents.

`ap-hook` is a C++ binary on Claude Code's tool calls — observe, write to a unix
socket, exit. `presenced` is one daemon per machine that coalesces, redacts and
keeps a snapshot on disk for the statusline. The relay is Python and owns leases
and collision arbitration. Dashboard and statusline are read-only subscribers.

Rooms key off a hash of the git remote, so cloning the repo is the setup. Leases
expire in 90s: if an agent dies you lose protection, you never wedge a teammate.

## Run it

From the repo root:

```
cd python && python3 -m venv .venv && .venv/bin/pip install -e '.[dev]' && cd ..
python/.venv/bin/agent-presence-relay              # 127.0.0.1:8799
claude mcp add agent-presence -- "$PWD/python/.venv/bin/agent-presence-mcp"
cmake -S cpp -B cpp/build && cmake --build cpp/build
./install.sh                                       # copy binaries, print hooks
```

The relay takes `--host`, `--port` and `--log-level`, or the same three as
`AGENT_PRESENCE_HOST` / `_PORT` / `_LOG_LEVEL`. Port 0 picks a free one and logs
it. `python -m agent_presence.serve` is the same entry point.

The MCP server derives room, agent and human from the repo it's launched in: git
remote, session id, `git config user.email`. `AGENT_PRESENCE_ROOM`, `_AGENT` and
`_HUMAN` override. `./install.sh --print-settings` prints the settings.json block
without touching anything; `AGENT_PRESENCE_BIN` sets the install dir.

Tests: `cd python && .venv/bin/python -m pytest`; `cmake -S cpp -B cpp/build &&
cmake --build cpp/build && ctest --test-dir cpp/build`; `cd web && npm install &&
npx vitest run && npx tsc --noEmit`. Bare `pytest` won't do, `sim/` only imports
via `-m`. Skip the web install and `npx tsc` fetches an unrelated package.

## What's broken

The MCP server keeps its own in-process registry instead of claiming over the
wire, so a claim through the tool never reaches another machine. Ladder tuning is
guesswork and the chain has only run against scripted clients, not real sessions.

Rung 4 (same work, different files) is off unless `AGENT_PRESENCE_RUNG4=1`;
`_RUNG4_THRESHOLD` moves the bar from 0.82. It matches declared intents by token
overlap over a hand-written synonym table, not embeddings, so paraphrase gets
missed. `python/tools/tune_rung4.py` prints the pairs it was tuned on.
