# dev server lock (#61, #62)

`browser.lock` was a file nobody's vite actually checked before binding
`--strictPort`, so it only serialized worktrees that chose to honor it —
how two teams' vite both ended up bound to 5173 at once, repeatedly.

`go/cmd/webdev` makes the port itself the lock. One process per machine
wins the bind on `:5173` and becomes the arbiter, reverse-proxying to
whichever worktree holds the lease. Everyone runs `pnpm dev`, which is
`go -C ../go run ./cmd/webdev --worktree "$PWD"` — `-C` is needed because
the go module lives at `go/`, not `web/`, but that leaves the child
process's cwd there too, so `--worktree` is passed explicitly or the
lease would record the wrong path and vite would run in the wrong
directory.

## How it works

1. `webdev` tries to bind `127.0.0.1:5173`. Whoever wins is the arbiter.
   Losing is normal — proceed to claim a lease from whoever won.
2. It picks a free port for its own vite (bind `:0`, note the port,
   close, hand it to `vite --port N --strictPort`), then `POST`s
   `/__devlock/claim` with that port.
3. Granted → vite starts, `:5173` proxies to it, including the HMR
   websocket upgrade. Refused → prints the current holder (owner,
   worktree, pid) and exits 1. No retry, no falling back to another port.
4. The lease renews every 20s against a 90s TTL, so a killed holder frees
   the port on its own. If the arbiter dies, survivors race the bind
   again and one re-elects.

## Endpoints (on :5173, served by the arbiter)

- `POST /__devlock/claim {owner, worktree, pid, port, force}` → granted or
  refused-with-holder.
- `GET /__devlock/status` → the current holder, or 404 if none.
- `--force` on the CLI breaks a live lease. Explicit operator action —
  use it when you're sure the current holder is dead, not as a habit.

## Residual risk

The port is only unstealable while a `webdev` process is alive holding
it. When the last one exits, `:5173` frees, and a raw
`vite --strictPort` run outside `webdev` could grab it before anyone
notices.

## Manual check

Start `pnpm dev` in a second worktree while the first still holds the
lease — it should refuse and exit non-zero. Manual, not a merge gate.
