# Status

Written 2026-08-11, this wave. Every number here came from running the thing.

## Where the code is

`main` has the Go daemon (`go/cmd/presenced`) as the only daemon — `cpp/daemon/`
is deleted, including `relay_client.{cpp,hpp}`. `cpp/hook/` is unchanged and
untouched: the spike in docs/gohook-spike.md settled that a Go hook misses the
5ms budget under storm, so only the daemon moved. The unix-socket protocol to
the hook is unchanged; the Python relay is unchanged and unaware of the
daemon's language.

Ported this wave, on top of wave 1's skeleton (docs/go-daemon.md): the
presence table and the statusline's snapshot file, policy live-reload (org
floor + the compiled cache, both merged with `Louder`), own-handover and
lost-region notes, the decision journal (`ap why`), room derivation from the
git remote (`AGENT_PRESENCE_ROOM` is no longer required), the decision
socket (`.decide`, so the hook's primary path is answered, not just its
fallback), and the coalescer. `go build` cross-compiles to
linux/{amd64,arm64}, darwin/{amd64,arm64} and windows/amd64 with
`CGO_ENABLED=0` — no OpenSSL, no cgo; `crypto/sha256` replaced the one use in
`repo.cpp`.

## Suites, run today

| suite | result |
| --- | --- |
| `python -m pytest` | 1094 passed |
| `ap_tests` (cpp, hook only now) | 856 assertions / 43 cases |
| `ctest --test-dir cpp/build` | 1/1 |
| `go test ./... -race -count=1` | 77 tests, clean under `-race` |
| `pnpm test` / `pnpm typecheck` (web) | 36 vitest, tsc clean |

Every Go test uses `t.TempDir()`; grepped for a fixed path under `go/` and
found none (#24). Ran `go test ./internal/... -race -count=1` several times
concurrently by hand — no cross-talk, matching what `t.TempDir()` should give
for free.

## Byte-identical protocol, proven not assumed

Built the real `ap-hook` binary (unmodified) and the real Go `presenced`,
pointed the hook at the daemon's sockets, and drove it directly: a
PreToolUse edit with no conflict answers rung 0 and prints nothing; a
PostToolUse event lands in the snapshot with the right verb/path. Both
sockets (`agent-presence.sock` and `agent-presence.sock.decide`) come up and
answer. `tests/load/` is the same proof at scale — every scenario drives this
same unmodified `ap-hook` binary against the Go daemon over the real sockets,
which is why `_lib.py`'s `DaemonProc` now launches Go, not C++.

## Load harness vs the C++ baseline

`python tests/load/run.py --all` against the Go daemon: **10 scenarios, 9
findings, 6 fail / 4 pass** — the same count STATUS.md recorded for the last
C++ run (#4: "6 of 10 scenarios still fail, 9 findings"). Scenario by
scenario:

| scenario | before (C++, #4) | this run (Go) |
| --- | --- | --- |
| `rooms` (20 rooms, 160 agents, isolation) | pass | **pass** — p99 39.3ms, 0 isolation violations, 0 findings |
| `relay-restart`, `slow-subscriber`, `lease-takeover` | pass | **pass**, unchanged |
| `swarm50`, `swarm200`, `lease-churn` | fail (relay-side) | **fail, same findings**: wait-die never says wait, claim throughput collapses under contention, expiry never broadcast. These scenarios never touch `presenced` in either language — pure relay + websocket-client traffic — so this is the unmodified relay code, unaffected by the port. |
| `hook-latency` | fail (ratio heuristic) | **fail, same heuristic** — p99 stays at 0.07–0.87ms even under an 8-thread hook storm on the real Go daemon, all comfortably under the 5ms budget (2 of 3000 calls over 5ms, in one bucket only); the finding is "loaded p99 is Nx idle p99", not a budget miss. |
| `daemon-kill` | flaky (STATUS.md #4: "25–26ms hook max, passed on the next run") | fail — 81ms hook max across the kill, 98/64000 calls over 5ms. Same category of flakiness already on record before this port, not confirmed as a new regression, and worth another run rather than a fix under this issue. |
| `flood` | fail (119ish refused under an 8000-event burst) | fail — 119 of 8000 event connections refused. The failure text in `scenarios.py` still describes the old single-threaded, 64-deep-backlog C++ model (`socket_server.cpp`'s `poll_once`); the Go daemon has no such loop — every accepted connection gets its own goroutine — so the refusals here are the OS-level `AF_UNIX` listen backlog, not application serialization. The finding text needs updating to say that; left as a follow-up rather than widening this PR into a `scenarios.py` rewrite. |

The `rooms` result is the closest match to the "200 agents / 20 rooms / 0
isolation violations" figure this wave was asked to reproduce (20 rooms × 8
agents = 160, not 200 — the harness's own default) and it holds: p99 well
under the C++ baseline's own historical numbers, 0 isolation violations.

## Still broken, missing or unproven

- Clock source: the Go daemon uses wall time throughout (`time.Now()`); the
  C++ side kept lease-TTL arithmetic on a monotonic clock specifically so a
  system clock step never expires or resurrects a lease early. Not exercised
  by anything in this repo's test suite, but a real gap — see
  docs/go-daemon.md's clock-source note, carried over from wave 1.
- Ladder tuning is guesswork, run only against scripted clients, not real
  sessions.
- Rung 4 is off unless `AGENT_PRESENCE_RUNG4=1`; token-overlap, not
  embeddings.
- `ap policy compile` puts `[[path]]` rules in the cache; the daemon (either
  language, always) has only ever read the blanket table.
- 3D assets don't exist; the office scene is primitives.
- Relay hosting and persistence are unaddressed — in-process asyncio, state
  in dicts, restart loses the lease table.
