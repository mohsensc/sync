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
- `POST /__devlock/release {owner, worktree, pid}` → frees the lease early; called on every exit path.
- `--force` breaks a live lease. Explicit operator action, not a habit.

## The `--force` takeover window

If the holder you `--force` out is also the arbiter, that process dies
(refused ⇒ die loudly) and `:5173` goes unbound until someone rebinds it.
Bounded, not open-ended: the forced-out arbiter checks its lease every 2s
and, on noticing, closes its listener immediately — before it even
signals vite to stop — so a hung vite ignoring SIGTERM can't hold the
port past that tick. The forcer races to rebind every 100ms for up to
5s, and its own heartbeat switches to the 2s interval the moment it wins
so a second `--force` doesn't reopen a 20s window. Net window is ~2s,
not the up-to-20s a heartbeat-only recovery would leave. Whoever wins
seeds the lock with its own claim first, so a stray third `pnpm dev`
landing in that window gets refused, not an empty lock to win. Separately,
the port is only unstealable while a `webdev` holds it — once the last
exits, a raw `vite --strictPort` could grab `:5173` first.

## Manual check

Start `pnpm dev` in a second worktree while the first holds the lease — it should refuse and exit non-zero. Manual, not a merge gate.
