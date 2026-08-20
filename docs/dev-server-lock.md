# dev server lock (#61, #62)

`browser.lock` was a file nobody's vite actually checked before binding
`--strictPort`, so it only serialized worktrees that chose to honor it —
how two teams' vite both ended up bound to 5173 at once, repeatedly.

`go/cmd/webdev` makes the port itself the lock. One process per machine
wins the bind on `:5173` and becomes the arbiter, reverse-proxying to
whichever worktree holds the lease. Everyone runs `pnpm dev`, which is
`go -C ../go run ./cmd/webdev --worktree "$PWD"` — `-C` because the go
module lives at `go/`, not `web/`, but that leaves the child's cwd there
too, so `--worktree` is passed explicitly or the lease records the wrong path.

## How it works

`webdev` races to bind `127.0.0.1:5173`; the winner is the arbiter,
seeding its Lock with its own claim before serving a single request.
Losing is normal — claim a lease from whoever won. Granted → vite starts
on a free port, `:5173` proxies to it (HMR upgrade included). Refused →
prints the current holder and exits 1, no retry, no falling back to
another port. The lease renews every 20s against a 90s TTL (2s once this
process is itself the arbiter — see below). If the arbiter dies,
survivors race the bind again and one re-elects.

## Endpoints (on :5173, served by the arbiter)

- `POST /__devlock/claim {owner, worktree, pid, port, force}` → granted or refused-with-holder.
- `GET /__devlock/status` → the current holder, or 404 if none.
- `--force` breaks a live lease. Explicit operator action, not a habit.

## The `--force` takeover window

If the holder you `--force` out is also the arbiter, that process dies
(refused ⇒ die loudly) and `:5173` goes unbound until someone rebinds it.
Bounded, not open-ended: the forced-out arbiter checks its own lease every
2s while serving `:5173` (not the normal 20s), so it exits fast; the
forcer races to rebind right after its claim lands — every 100ms for up
to 5s — instead of waiting for a heartbeat tick. Net window is ~2s, not
the up-to-20s a heartbeat-only recovery would leave. Whoever wins the
rebind seeds the lock with its own claim first, so a stray third
`pnpm dev` landing in that window gets refused, not an empty lock to win.

Separately: the port is only unstealable while some `webdev` holds it —
once the last one exits, a raw `vite --strictPort` outside `webdev` could
grab `:5173` first.

## Manual check

Start `pnpm dev` in a second worktree while the first still holds the
lease — it should refuse and exit non-zero. Manual, not a merge gate.
