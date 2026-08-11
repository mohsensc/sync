# The Go daemon (wave 1 of #18)

`go/` is an experimental, opt-in replacement for `cpp/daemon`. It exists to kill
1,783 hand-rolled lines of RFC 6455 in `relay_client.cpp` — see #18. This is the
de-risking half: prove the two protocols port cleanly. It does not replace
anything yet.

The C++ daemon (`presenced`) stays the default. Nothing in `install.sh` or
anywhere else in the tree invokes the Go binary. `cpp/daemon/relay_client.{cpp,hpp}`
is untouched and still 1,783 lines.

## Running it

```
cd go && go build -o godaemon ./cmd/godaemon
AGENT_PRESENCE_GO_DAEMON=1 AGENT_PRESENCE_ROOM=myroom ./godaemon
```

Refuses to do anything without `-enable` or `AGENT_PRESENCE_GO_DAEMON=1` — a
safety rail on top of "nothing calls this binary," not a substitute for it.
Same env vars as `presenced` (`AGENT_PRESENCE_SOCK`, `AGENT_PRESENCE_RELAY`,
`AGENT_PRESENCE_AGENT`, `AGENT_PRESENCE_HUMAN`, `AGENT_PRESENCE_PRINCIPAL`,
`AGENT_PRESENCE_TOKEN`, `AGENT_PRESENCE_UNATTENDED`), except `AGENT_PRESENCE_ROOM`
must be set explicitly — see "Not ported" below.

Tests: `cd go && go test ./...`. Cross-compiles with no extra tooling since it's
pure Go plus `gorilla/websocket` (no cgo):
`CGO_ENABLED=0 GOOS=linux GOARCH=arm64 go build ./...` and the same for
windows/amd64, darwin/arm64 all build clean from this checkout — that's #21.

## What's ported

- The unix-socket protocol to the hook (`internal/hooksock`): line-delimited
  JSON in, an optional line-delimited JSON reply out, same rules as
  `cpp/daemon/socket_server.cpp` — empty reply means no answer, hook reads that
  as allow.
- The websocket wire protocol to the relay (`internal/relay`, `internal/wire`):
  join, event, contend, and parsing of presence/leases/lease/claim_result/policy
  frames off `gorilla/websocket` instead of a hand-rolled RFC 6455 client.
- Reconnect with exponential backoff (`Config.BackoffMin`/`BackoffMax`, doubling,
  same shape as `RelayClient::drop`).
- Bounded, drop-oldest outbound buffering (`internal/outbound`) — presence is
  only useful while current, so an outage sheds the oldest queued frame first,
  same as `cpp/daemon/outbound.cpp`.
- A minimal lease cache (`internal/leases`) and decision responder
  (`internal/decide`) good enough to answer rung 0 / rung 3, which is what let
  the end-to-end test prove a real conflict round-trips through both sockets.
- `encoding/json` structs (`internal/wire`) instead of `relay_client.cpp`'s
  hand-rolled JSON scanner — that's #19.
- Goroutines and channels doing the concurrency work the C++ single-threaded
  poll loop did by hand: the relay connection runs on its own goroutine
  (`Client.Run`), with a read pump and a write pump coordinated by a `stop`
  channel and `context.Context` — that's #20. This is a genuine shape change,
  not just a port; see "Concurrency model" below.
- `t.TempDir()` throughout the Go tests for the hook socket's path — that's
  #24. Worth calling out explicitly: `t.TempDir()`'s default location can run
  right up against `AF_UNIX`'s ~104-byte `sun_path` limit on macOS. The tests
  use a one-byte socket filename and assert the path length rather than
  silently truncating or failing cryptically at `bind()`.

## What's not ported (wave 2)

- **The C++ daemon is not deleted and the default is not flipped.** Both are
  explicitly out of scope for this PR per the issue.
- **TLS.** `ws://` only; `wss://` is refused at startup, same as
  `parse_relay_url` refusing to silently downgrade. That's #22.
- **Presence table and the snapshot file the statusline reads.** `OnPeer` just
  logs today. No `agent-presence.json`, no statusline integration.
- **Policy live-reload.** The Go daemon answers off the compiled-in floor
  (`decide.builtinFloor`, matching `kBuiltinFloor`) for the life of the
  process. A `policy` frame from the relay is parsed and logged but never
  applied — an org floor change reaching a running Go daemon does nothing
  yet.
- **Handover bookkeeping.** `leases.Cache` has no `own_handover` /
  `handover_note` equivalent, so an agent that loses a region gets no
  `lost_to` note on its next edit, and a holder gets no warning that its
  lease has a deadline. `own_handover`/`lost` fields on a "lease" frame are
  parsed into nothing.
- **Decision journal.** No `ap why` equivalent; nothing is recorded to disk.
- **Contend queue → handover deadline.** A blocked decision does push a
  `contend` frame (so the relay starts a deadline on the holder), but nothing
  reads that back into a warning the way `main.cpp`'s `ContendQueue` does.
- **Room derivation from a git remote.** `main.cpp`'s `discover_room()` hashes
  `git remote get-url origin`; the Go binary only reads `AGENT_PRESENCE_ROOM`.
  No room means no relay connection, same fail-open rule as the C++ side.
- **Token discovery from `~/.config/agent-presence/token`.** Env var only.
- **Principal/token roster enforcement details** beyond sending them on join —
  the relay decides what they mean either way, so this is a smaller gap than
  it sounds, but `join_refused` handling here is just a log line.

## Concurrency model, honestly

The issue asks the Go version to "preserve the behaviour that matters:
reconnect, backoff, bounded outbound buffering, the non-blocking connect
state machine." The first three are ported as stated. The fourth is not a
literal port, on purpose.

`RelayClient` in C++ is a hand-written state machine (`Idle` → `Resolving` →
`Connecting` → `Handshaking` → `Open` → `Backoff`) polled cooperatively from
the daemon's one thread, specifically so a slow relay connection can never
delay a hook answer — the daemon has no other thread to fall back on.

Go's daemon doesn't have that constraint: `internal/hooksock` gives every
accepted hook connection its own goroutine, and `internal/relay.Client.Run`
drives the whole connect/backoff/read/write cycle on a goroutine of its own.
The guarantee — a stuck or slow relay connection cannot block a hook answer —
holds for a structural reason (separate goroutines, no shared thread to
starve) rather than because of a hand-tuned non-blocking state machine. That's
the idiomatic trade in Go, not a shortcut: forcing the same explicit state
machine here would fight the language for no behavioral gain.

One real behavior difference from this: the C++ client's `poll(0)` is called
from the same loop that answers hooks, so a relay operation literally cannot
run concurrently with a hook decision even in principle. In Go, the relay
goroutine and a hook-decision goroutine can touch `leases.Cache` at the same
moment; `leases.Cache` uses a `sync.RWMutex` to make that safe, which is the
same solution `cpp/daemon/lease_cache.hpp` already uses (`std::shared_mutex`)
for the same reason — decision threads there already run alongside the main
loop via `DecisionServer`.

## Clock source

`internal/relay` and `internal/decide` use `time.Now().UnixMilli()` — wall
clock — throughout. The C++ side is careful to keep lease-TTL arithmetic on
`steady_clock` (monotonic) and only ever put `system_clock` (wall) into the
journal, specifically because a system clock step must never expire or
resurrect a lease early. The Go side doesn't make that distinction yet: an
NTP step or a manual clock change during a long-running Go daemon process
could shift when a cached lease is treated as expired. Not exercised by
anything here, and there's no journal yet to need wall time separately, but
it's a real, documented gap rather than an oversight — worth fixing before
wave 2 adds anything that leans harder on lease timing.
