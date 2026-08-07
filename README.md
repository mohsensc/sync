# Agent Presence

When a few people on a team each run coding agents against the same repo, nobody
can see what the agents are doing and the agents can't see each other. They
duplicate work and overwrite each other, and you find out at merge time.

This is one event stream with two readers: an ambient animated world for humans,
and claims plus negotiation messages for agents.

Early MVP. Right now the repo is docs only — there's no code yet.

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

## How to run it

Nothing to run yet. When there is, it'll be:

```
cd python && pytest
cmake -S cpp -B cpp/build && cmake --build cpp/build && ctest --test-dir cpp/build
cd web && npm test
```

## Docs

- `docs/design.md` — what it is and why it's shaped this way.
- `docs/plan.md` — the task-by-task build order.

## What's broken

Everything, in the sense that none of it exists. Known unknowns from the design:
the collision ladder's tuning is guesswork until real traffic hits it, and the
5ms hook budget hasn't been measured on anything.
