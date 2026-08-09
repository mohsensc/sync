# Agent Presence

A few people on a team run coding agents against the same repo. The agents can't
see each other, so they duplicate work and overwrite each other and you find out
at merge time. One event stream: ambient for humans, claims for agents.

`ap-hook` is a C++ binary on Claude Code's tool calls — observe, write to a unix
socket, exit. `presenced` coalesces and snapshots; the Python relay owns leases
and arbitration. Leases expire in 90s, so a dead agent never wedges a teammate.

## Run it

```
cd python && python3 -m venv .venv && .venv/bin/pip install -e '.[dev]' && cd ..
python/.venv/bin/agent-presence-relay              # 127.0.0.1:8799
claude mcp add agent-presence -- "$PWD/python/.venv/bin/agent-presence-mcp"
cmake -S cpp -B cpp/build && cmake --build cpp/build
./install.sh                                       # copy binaries, print hooks
```

The relay takes `--host`, `--port` and `--log-level`, or the same three under
`AGENT_PRESENCE_*`; port 0 picks a free one. The MCP server and `presenced`
derive room, agent and human from the repo, and `AGENT_PRESENCE_*` overrides them.

## Policy

How loudly a collision gets told is a TOML file and `ap` is the verb surface over
it. Saved is applied, nothing restarts. MCP stays read-only: the agent that gets
blocked shouldn't be the one that turns blocking off.

```
ap policy show --effective     # what's in force, and which file said so
ap policy set rung3=ask        # writes ~/.config/agent-presence/policy.toml
ap policy explain src/pay.py --rung 3    # which rule fired, and what it beat
ap why                         # the last decisions and why they went that way
ap doctor                      # is any of this actually reaching the daemon
```

Who outranks whom is `.agent-presence/principals.toml`, committed so priority
gets reviewed in a PR. `ap principals add sara --attended elevated` prints a
token once; put it in `~/.config/agent-presence/token` and `presenced` presents
it on join. Seniority among people playing along, not a security boundary.

Tests: `cd python && .venv/bin/python -m pytest` (bare `pytest` misses `sim/`);
`cmake -S cpp -B cpp/build && cmake --build cpp/build && ctest --test-dir
cpp/build`; `cd web && pnpm install --frozen-lockfile` then its local binaries.

## What's broken

The MCP server keeps an in-process registry instead of claiming over the wire, so
a claim through the tool never reaches another machine. Rung 4 isn't built, and
`ap policy compile` resolves one path, so a `[[path]]` rule only covers that one.
