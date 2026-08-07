# Agent Presence

When a few people on a team each run coding agents against the same repo, nobody
can see what the agents are doing and the agents can't see each other. They
duplicate work and overwrite each other, and you find out at merge time.

This is one event stream with two readers: an ambient animated world for humans,
and claims plus negotiation messages for agents.

## Shape

Four processes:

- **hooks** — a small C++ binary on Claude Code's tool calls. Observe, write to a
  unix socket, exit. 5ms p99, hard cap.
- **presenced** — one daemon per machine. Coalesces, redacts, keeps one WebSocket
  to the relay and a snapshot on disk for the statusline.
- **relay** — Python. The only stateful part. Owns leases and collision
  arbitration.
- **dashboard / statusline** — read-only subscribers.

Rooms are keyed off a hash of the git remote, so cloning the repo is the whole
setup. Leases expire in 90s. Nothing is permanent — if an agent dies you lose
protection, you never wedge a teammate.

## Run it

```
cmake -S cpp -B cpp/build && cmake --build cpp/build   # build the binaries
cd python && pip install -e '.[dev]'                   # install the Python side
python -m agent_presence.serve                         # run the relay
./install.sh                                           # copy binaries, print hook config
```

`./install.sh --print-settings` just prints the block for `~/.claude/settings.json`
without touching anything. `AGENT_PRESENCE_BIN` overrides the install dir
(default `~/.local/bin`).

Tests: `cd python && pytest`, `ctest --test-dir cpp/build`, `cd web && pnpm test`.

## What's broken

The collision ladder's tuning is guesswork until real traffic hits it, and the
5ms hook budget hasn't been measured under load. Rung 4 (redundant work on
different files) isn't implemented — it needs embedding similarity and would be
noisy today. Dashboard renders placeholder primitives, no real assets.
