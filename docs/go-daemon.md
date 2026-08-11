# The Go daemon (#18, complete)

`go/cmd/presenced` is the daemon. `cpp/daemon/` is deleted, including the
1,783-line hand-rolled `relay_client.cpp` this issue existed to kill. The hook
stays C++ — `docs/gohook-spike.md` measured a Go hook missing the 5ms budget
under storm — but the daemon never had that constraint, and the C++/Go seam
was always the unix socket between the two.

## Running it

```
cd go && go build -o presenced ./cmd/presenced
AGENT_PRESENCE_ROOM=myroom ./presenced       # or let it derive the room, see below
```

No flag, no env var gate — this is the daemon `install.sh` installs. Same env
vars as before: `AGENT_PRESENCE_SOCK`, `AGENT_PRESENCE_SNAPSHOT`,
`AGENT_PRESENCE_POLICY_CACHE`, `AGENT_PRESENCE_JOURNAL`, `AGENT_PRESENCE_RELAY`,
`AGENT_PRESENCE_AGENT`, `AGENT_PRESENCE_HUMAN`, `AGENT_PRESENCE_PRINCIPAL`,
`AGENT_PRESENCE_TOKEN`, `AGENT_PRESENCE_UNATTENDED`. `AGENT_PRESENCE_ROOM` is
now optional: unset, the daemon hashes `git remote get-url origin` the same
way `main.cpp`'s `discover_room()` did (`go/internal/repo`, `crypto/sha256`
instead of OpenSSL — see #21). No remote still means no relay, same fail-open
rule as before.

Tests: `cd go && go test ./... -race -count=1`. Cross-compiles with no cgo:
`scripts/build-go-release.sh` builds linux/{amd64,arm64}, darwin/{amd64,arm64}
and windows/amd64 from one machine, wired into CI on every PR and into
`.github/workflows/release.yml` on a `v*` tag.

## What's here

- `internal/hooksock` — the unix-socket protocol to the hook. Two servers now,
  event socket and `.decide`, matching `hook/protocol.hpp`'s split exactly:
  the hook's primary path talks to `.decide`, and the event socket still
  answers decisions too, for a hook old enough to only know the one socket.
  No C++-style worker pool needed for either — every accepted connection gets
  its own goroutine, so there is no shared accept queue for a decision to
  wait behind in the first place (that was the entire reason
  `decision_server.cpp` existed).
- `internal/relay`, `internal/wire` — join, reconnect with backoff, bounded
  drop-oldest outbound, frame parsing via `gorilla/websocket` and
  `encoding/json` (#19). `wss://` dials with certificate verification on by
  default (#22) — see `docs/tls-dev-cert.md` and `docs/threat-model.md`.
- `internal/leases` — the lease cache, now including handover deadlines and
  lost-region notes (`HasHandover`, `NoteHandover`/`HandoverNoteFor`,
  `OwnHandover`) — the Go equivalents of `lease_cache.hpp`'s `HandoverNote`
  and `own_handover`. An agent that loses a region gets a `lost_to` note on
  its next edit; a holder on the clock gets a `handover_in_ms` warning.
- `internal/policy` — the decision-relevant slice of policy: `Builtin`,
  `BuiltinFloor`, a file-backed local table (`Refresh`, mtime/size-gated,
  `encoding/json`) merged with the relay-pushed org floor via `Louder`. Live
  reload: a `policy` frame from the relay reaches every decision within one
  daemon tick, no restart.
- `internal/journal` — `ap why`'s writer. One goroutine owns the file;
  `Record` is a non-blocking channel send, so a decision never waits on disk
  I/O. See "Concurrency model" below for why this isn't a port of
  `journal.cpp`'s locking.
- `internal/presence` — the presence table and `WriteSnapshot`, hand-escaped
  (not `encoding/json`) to stay byte-compatible with
  `scripts/statusline-presence.sh`'s bash parser, which only unescapes `\\`
  and `\"`.
- `internal/contend`, `internal/coalesce` — the contend queue (a blocked
  PreToolUse pushes a `contend` frame so the relay starts a handover
  deadline) and the coalescer capping/deduping outbound relay traffic. Both
  plain mutex-guarded structs, not goroutine-owned — see below.
- `internal/decide`, `internal/daemon` — decision responses now cover the
  full wire shape: handover fields, `handover_to_me`, `lost_to`/`lost_to_agent`
  /`lost_to_priority`/`lost_ms_ago`, all gated on the same rung/effect rules
  `decide.cpp` used.
- `internal/repo` — `NormalizeRemote`/`RoomIDFromRemote`, ported from
  `repo.cpp`/`room_key.py` byte for byte; pinned by the same cross-language
  test vectors (`go/internal/repo/repo_test.go`,
  `python/tests/test_room_key_ascii_contract.py`).

## Concurrency model, honestly

Issue #20 asks for "each shared resource owned by one goroutine, mutated only
via channels." That is the right shape for exactly the things the policy
audit found broken in C++ — the journal's trim deadlocking against `record()`,
and decisions starved behind event traffic — and both are structurally fixed
here, not patched:

- **The journal** is owned by one goroutine end to end. `Record` sends on a
  buffered channel and returns; the owning goroutine appends, and trims on its
  own 100ms tick with nothing else able to touch the file. There is no lock at
  all, because there is no second writer to lock against — the C++ version's
  shared/exclusive split and its splice-tail dance existed only to let several
  decision *threads* write concurrently; a single goroutine cannot deadlock
  against itself, which is literally the property #20 names.
- **Decision starvation behind event traffic** doesn't need a dedicated
  worker pool the way `DecisionServer` did. `hooksock.Server` gives every
  accepted connection its own goroutine the moment `accept()` returns, so
  there is no shared accept queue for a burst of events to occupy ahead of a
  decision — the underlying cause of the 60% loss rate `decision_server.hpp`
  documents. The `.decide` socket is still separate, matching the wire
  protocol the hook expects, but the concurrency reason for the split doesn't
  transfer: it's now belt-and-suspenders on top of a structural fix, not the
  fix itself.

Where a plain `sync.Mutex`/`sync.RWMutex` stayed instead of a channel-owned
goroutine — `leases.Cache`, `policy.Cache`, `contend.Queue`,
`daemon.coalescer` — that's deliberate, not a shortcut: none of these were
ever the bug. They're read-mostly caches or small dedup structures with one
critical section each, exactly the shape `std::shared_mutex` already handled
correctly in C++. Forcing every one of them through a request/response
channel would add a goroutine and a round trip for no behavioral gain, and
`go test ./... -race` is what proves the mutexes are actually sufficient
rather than merely assumed to be.

## Clock source

Both `internal/relay` and the daemon's own ticks use `time.Now()` — wall
clock — throughout. The C++ side kept lease-TTL arithmetic on `steady_clock`
specifically so a system clock step never expires or resurrects a lease
early. This is a real, carried-over gap from wave 1, not fixed this wave:
nothing in the test suite exercises a clock step, and fixing it (a
monotonic-safe timer source in Go, `time.Since`/`Timer` built on the
runtime's monotonic reading rather than `UnixMilli()`) is follow-on work, not
blocking anything this wave shipped.
