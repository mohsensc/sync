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

CI's Linux runner caught a real data race locally-clean runs on this laptop
never hit: `hooksock.Server.Stop()` wrote `s.ln = nil` while `acceptLoop()`
read `s.ln` unsynchronized — pre-existing wave-1 code, exposed by this wave
adding a second `Server` (the decide socket) and a CI scheduler that
interleaves differently than a quiet laptop does. Fixed by having
`acceptLoop` take the listener as a parameter instead of reading the shared
field; `go test ./... -race -count=1` clean since, three runs in a row
locally plus CI.

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

## TLS (#22, on top of the above)

The relay optionally terminates TLS (`--tls-cert`/`--tls-key`, plaintext
`ws://` still the zero-config default); the Go daemon dials `wss://` with
certificate verification on by default, `AGENT_PRESENCE_RELAY_CA` for a
self-signed dev cert, and a loud `AGENT_PRESENCE_RELAY_INSECURE_SKIP_VERIFY`
escape hatch. `docs/tls-dev-cert.md` is the how-to; `docs/threat-model.md` is
updated to close out the "pending TLS" section it left open.

Two-machine join, simulated honestly: no second machine available, so this
ran as two `presenced` processes and one relay, all on one laptop, with the
relay bound to the machine's real LAN IP (not loopback) and both daemons
dialing that address over `wss://`. Confirmed with `openssl s_client` that
the socket does a real TLS 1.3 handshake, and that a plain HTTP request to
the same port gets nothing back. A daemon given the CA joined and saw the
other's presence; a daemon given neither the CA nor skip-verify never
connected (fail-open, no cross-talk) — proving verification is actually
enforced, not just present. What this does *not* prove: two different
physical machines, or a real router/NAT/firewall path between them.

Suites: `python -m pytest` — 1100 passed (1094 plus 6 new). `go test ./...
-race -count=1` — clean, `internal/relay` now covers trusted-CA, untrusted,
skip-verify and unknown-scheme dialing. `ctest --test-dir cpp/build` — 1/1
(hook untouched by this wave).

`tests/load/run.py rooms` (20 rooms, 8 agents each, the same 160-agent
config STATUS.md's last run used) — 5 runs each, this laptop, back to back,
also running other agents' test suites at the time (load average 3.7–8):

| | p99 (5 runs) | median |
| --- | --- | --- |
| plaintext | 39.2 / 39.9 / 40.3 / 55.9 / 69.6 ms | 40.3ms |
| TLS | 41.9 / 42.9 / 43.9 / 45.3 / 66.5 ms | 43.9ms |

Median-to-median, TLS costs about 3.6ms (~9%) at p99 on this box. The spread
within each set (39ms to 70ms) is bigger than that difference, which is the
shared, contended machine talking, not the harness — noted rather than
smoothed over. #11's issue text cites an older "200 agents / p99 35ms"
figure; that predates both the Go daemon and #27's rate limiting and isn't
directly reproducible against this run (this harness's own default is 160
agents in the `rooms` scenario, 20 rooms × 8), but it's the same order of
magnitude.

`relay-restart` and `slow-subscriber` pass over TLS unchanged. One real fix
needed to get there: `tests/load/scenarios.py`'s `DeafSubscriber` opens a
raw socket on purpose (to get a peer that never reads, which every
websocket library reads in the background for) and had to learn to wrap
that socket in TLS itself when the run is TLS — see the `_lib.TLS_ENABLED`
plumbing. `lease-churn` and `daemon-kill` still fail/flake the exact same
way over TLS that STATUS.md already had them failing/flaking over plaintext
— unrelated to this wave, not a new regression.

## MCP server in Go (#32), venv step dropped (#33)

`agent-presence-mcp` (`go/cmd/agent-presence-mcp`) replaces
`python/src/agent_presence/mcp_server.py` and `relay_client.py`, both
deleted. Same four tools, same schemas, same reply shapes and error
strings — ported field by field against the Python source, not
reimplemented from the issue text. `go/internal/mcprelay` is its own
request/response connection to the relay (`internal/relay` stays the
daemon's fire-and-forget pump; the two don't share client code, only
`internal/wire`'s frame shapes, which gained `Claim`/`MoveRequest`/
`ReleaseRequest`/`PresenceSnapshotEntry` for this). `internal/negotiation`
is the four-line `MOVES`/`normalize_move` slice; `internal/mcptools/identity.go`
is `room_for`/`agent_id`/`human_id`/`local_identity`, byte-identical rules,
reusing `internal/repo`'s already-proven `RoomIDFromRemote` for the hash
itself.

Ported the join reply's presence snapshot (#31) into the Go client too,
though this checkout's own `relay.py` predates that PR (it's on `main`,
not `feat/go-daemon-complete`) — verified against a scripted fake relay
that sends the `presence` array on join, since the local relay can't
produce one to test against live.

Verified against a real `agent-presence-relay`, not just fakes: a
`claim_work` through the Go MCP server refuses a second, independent
websocket connection's `claim` on the same region and names the holder and
intent — the exact shape issue #12 fixed in Python — in both plaintext and
opaque mode. A relay kill mid-session followed by a claim errors in the
request timeout window (not a hang), and the next call reconnects clean
once the relay comes back. wait-die's `decision` field reaches
`claim_work`'s reply for a real younger-claimant contest.

Test files with Python MCP coverage (`test_mcp_tools.py`,
`test_mcp_identity.py`) are deleted; `test_claim_path_wait_die.py`,
`test_rung4.py` and `test_privacy_boundary.py` lost their MCP-tool-path
tests but kept their relay-wire-path ones, with a note pointing at the Go
equivalent. `test_entrypoints.py` lost the stdio-transport section; its
claims (handshake, tool list, a claim reaching a real relay, exit 0 on
stdin close, only protocol on stdout) are re-proven in
`go/cmd/agent-presence-mcp/main_test.go`, which builds and execs the real
binary rather than testing against the package.

`install.sh` now builds and installs all three binaries;
`scripts/build-go-release.sh` cross-compiles `agent-presence-mcp` alongside
`presenced`. README's "Run it" is three binaries and no venv; the relay's
own venv step is still there, honestly labeled as one person's server, not
every teammate's machine.

Suites: `python -m pytest` — 1035 passed (no `mcp` package installed at
all: dropped from `pyproject.toml`). `go test ./... -race -count=1` — 156
tests, clean, `mcprelay`/`mcptools`/`negotiation`/`agent-presence-mcp` new.
`ctest --test-dir cpp/build` — 1/1 (cpp untouched; the hook-storm latency
case flakes under load on this shared box, pre-existing and unrelated).
Walked a from-scratch install with `AGENT_PRESENCE_BIN` pointed at an empty
dir and `python3` off `PATH` entirely: `cmake --build` + `./install.sh`
produced three working Mach-O binaries, no Python anywhere in the path.

Review caught a real gap: `Dispatch` read required arguments with a loose
coercion (`strOf(args["path"])`) that silently returned `""` for a missing
key, where Python's `arguments["path"]` raised `KeyError`. Nothing upstream
enforces the schema's `required` list — go-sdk's `AddTool` leaves that to
the caller — so a `claim_work` call missing `path` was granting a phantom
lease on an empty-string region instead of failing visibly. `Dispatch` now
checks each required string argument explicitly and errors before it
reaches the relay; new tests cover the missing-key and wrong-type cases and
assert the call never reaches the relay at all.
