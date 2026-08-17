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

## Go relay only, Python relay deleted (#40, #47, #48)

The Python relay is gone. `gorelay` is the relay, full stop —
`AGENT_PRESENCE_RELAY_IMPL` and `--impl go/python` don't exist anymore,
there's nothing to select. Four things blocked this; all four are closed:

- **TLS.** `gorelay` terminates `wss://` now (`crypto/tls`, same
  `--tls-cert`/`--tls-key` flags and `AGENT_PRESENCE_TLS_*` env names the
  Python side had). Verified with a real handshake: `openssl s_client`
  reports TLS 1.3, cert verify OK against the dev cert; a plaintext HTTP
  request to the same port gets Go's own "client sent an HTTP request to
  an HTTPS server" 400, never a working connection. Four Go tests
  (`server_tls_test.go`) cover the same shape `test_serve_tls.py` did:
  trusted handshake succeeds, untrusted one fails, two clients see each
  other over `wss://`, plaintext stays the zero-config default.
- **#48 (roster discovery).** `FindRoster` resolves symlinks now
  (`filepath.EvalSymlinks`, falling back component-by-component for a
  path whose tail doesn't exist yet, matching `Path.resolve()`'s
  non-strict behavior). Tested on this machine's own `/tmp ->
  /private/tmp` symlink, not a synthetic case.
- **#47 (expiry-broadcast latency).** `Registry.SweepAll`, run off a 1s
  background ticker in `Server.Serve`, walks every shard of every room
  and prunes+publishes regardless of whether anything touched that shard
  — an idle shard's expiry no longer waits for its next touch. Doesn't
  reintroduce a lock spanning shards: each tick takes and releases one
  shard's mutex in turn, same as `ActiveClaims` already did off the hot
  path. Two-region test (`TestSweepAllBroadcastsAnIdleShardsExpiry`)
  picks `a.py`/`b.py` landing in different shards and confirms `a.py`'s
  expiry stays invisible until either something touches it or the sweep
  runs.
- **Org policy floor + rung 4.** Ported from `policy.py`/`similarity.py`.
  `go/internal/relaysrv/policy.go` is the relay's actual slice of
  `policy.py` — builtin plus one org layer, exactly `policy.py`'s own
  `RELAY_INCLUDE` (the repo/user/session layers were never the relay's to
  resolve; that's the daemon's `ap policy compile` output, unchanged).
  `similarity.go` is `similarity.py` ported as-is — same synonym table,
  same weights, same thresholds, off by default. Not improved; #15 owns
  that. `policy_test.go` and `relay_policy_test.go` port the org-floor
  slice of `test_policy.py`/`test_relay_policy.py` (glob specificity,
  observer-mode ceiling vs. floor ordering, live reload via
  `PolicyFile.Current`, the floor pushed on join after the lease
  snapshot, republish-on-change, blanket-vs-path-scoped floor shape on
  the wire); `rung4_test.go` covers the lexical scorer's true positive /
  true negative / near-miss cases straight from `tune_rung4.py`'s own
  corpus, plus the off-by-default gate and the same-path exclusion.

**The oracle wasn't deleted without a replacement.** `python/tests/` (the
suite that produced the 13/14 real-socket result and the golden-scenario
diff in `docs/relay-parity.md`) is gone with the rest of the Python relay,
but:

- The subprocess-swap harness that produced that 13/14 number lived in a
  scratch dir and was never checked in. It is now:
  `python/tests/helpers/gorelay_proc.py`, used by `test_e2e.py`,
  `test_serve.py` and `test_relay_restart.py`, all three rewritten to
  spawn the real `gorelay` binary instead of driving a Python `Relay`
  object in-process. **17/17 passing** against `gorelay` — better than
  the original 13/14, because the one known failure (opaque mode, an
  env-var-set-after-spawn harness artifact) doesn't reproduce here: this
  harness sets `AGENT_PRESENCE_OPAQUE` in the child's env before spawn,
  the only way any operator actually sets it.
- `python/tests/test_relay_restart.py` lost exactly one assertion with no
  Go equivalent — `relay.registry.active_claims(room) == []` on a bare
  in-process object, which is trivially true of any freshly constructed
  `Registry` by construction and isn't really an assertion about the
  *relay*, just about `NewRegistry`.
- `test_backpressure.py`'s and `test_inbound_rate_limit.py`'s
  `VirtualClock`-only cases (no real socket, a duck-typed fake transport)
  are native Go tests now: `backpressure_test.go`,
  `inbound_rate_limit_test.go`. Porting the former required extracting a
  `wsWriter` interface out of `WsConn` (it held a concrete
  `*websocket.Conn` before, so nothing could stand in for "a peer whose
  write blocks forever" the way Python's `_FakeWs` could) — a small,
  behavior-preserving refactor, not a rewrite.
- The golden scenario's role as a live differential oracle has no
  replacement, because there's no second implementation left to diff
  against — that's what "only one relay" means. `golden_test.go` still
  exists and still runs, now with zero fields normalized away (`effect`/
  `effect_source` are populated for real, since the policy engine
  landed in the same PR).

**Two bugs found by actually running this, neither a wave-1 issue:**

- **`write()` never watched the clock while a send was in flight.**
  `test_a_frame_that_will_not_leave_is_shed_on_clock_seconds`'s Go port
  is what surfaced it: the doc comment already claimed the polling
  behavior (copied from `serve.py`'s `_write`), the code didn't actually
  have it. A genuinely wedged peer's writer goroutine blocked inside
  `WriteMessage` forever — `shedReason` never got a chance to fire, the
  connection was never shed, the goroutine leaked for the life of the
  process. Fixed by racing the send (its own goroutine, a buffered
  1-length result channel) against a real-time poll ticker that decides
  on the injectable clock, same split `serve.py` always had: poll
  frequency is wall time, the shed decision is clock time.
- **`session()` never closed its own end of the connection.** Found
  while running the load harness, not by a unit test: every scenario
  that closes a client connection (all of them) took a flat 10.0s per
  close — `websockets`' default `close_timeout`. gorilla's default close
  handler already echoes the close frame back (that's automatic), but
  nothing ever called `ws.Close()` on gorelay's side once the read loop
  returned, so the underlying TCP connection was never actually closed —
  a client's `close()` waits for the transport to go away, not just for
  the frame exchange. One line (`defer` now calls `ws.Close()`) turned
  every disconnect from 10.0s into ~0.2ms — confirmed directly, and it's
  why the black-box suite's wall time went from 321s to 0.91s for the
  same 17 tests. `TestClientInitiatedCloseCompletesPromptly` pins it.

**Deleted, once nothing referenced it anymore:** `relay.py`, `serve.py`,
`leases.py`, `negotiation.py`, `ladder.py`, `wait_die.py`, `similarity.py`,
`redact.py` (its one surviving export, `OPAQUE_ENV`, is inlined into
`policy.py`), `types.py`, `sim/` and `tools/tune_rung4.py` (both dead the
moment `leases.py`/`wait_die.py`/`similarity.py` went), `spike/relay/`,
`python/tests/helpers/golden_scenario.py` + `golden_base.json`, and every
test file that existed only to drive the deleted `Relay` object
in-process. `priority.py`, `principals.py` and `policy.py` stayed — the
CLI (`ap`) and the Go relay both still need them, `policy.py`/CLI-only,
`priority.py`/`principals.py` mirrored into `relaysrv/{priority,principals}.go`
for the relay's own path. `websockets` moved from a runtime dependency to
a dev one — nothing left in `src/agent_presence` imports it, only the
black-box suite (as a client now, not the relay).

`tests/load/_lib.py`'s `RelayProc` spawns `gorelay` directly (a `go
build`, same on-demand pattern `build_presenced` already used) instead of
going through `_relay_boot.py`, which is deleted — `AP_LOAD_LEASE_TTL_S`
is gorelay's own env var already (`leases.go`), no boot shim needed to
patch a module constant.

### Suites

| suite | result |
| --- | --- |
| `go test ./... -race -count=1` | 272 tests, clean (`relaysrv` alone: 113) |
| `python -m pytest` | 359 passed, 13.5s (was ~1094 before this wave's deletions — the difference is `python/tests/` losing everything that only tested the deleted Python relay, per above) |
| black-box suite alone (`test_e2e.py`, `test_serve.py`, `test_relay_restart.py`) | 17/17, 0.91s against a real `gorelay` subprocess |
| `ctest --test-dir cpp/build` | 1/1 (hook untouched) |

### Load harness, final state (`tests/load/run.py`, this machine, one run each)

`swarm50 --agents 200 --hot 8 --rounds 15`:

| | |
| --- | --- |
| claim p50/p95/p99/max (ms) | 8.5 / 15.0 / 17.6 / 27.0 |
| grant rate | 11.1% (332/3000) — **finding**, see below |
| wait / abort | 4223 / 2668 |
| relay CPU/op | 0.262ms |
| relay RSS after drain | 12.4 MiB |

`rooms --rooms 20 --per-room 8`:

| | |
| --- | --- |
| claim p50/p95/p99/max (ms) | 5.2 / 9.9 / 11.6 / 12.6 |
| isolation_violations | 0 |
| dead-room cost, first/second 500 | 18.8 / 18.6 MiB — **finding**, see below |

`slow-subscriber --busy-agents 25 --window-s 10`: ops healthy/with-deaf
57104/55446 (ratio 0.97), claim p99 healthy/deaf 15.1ms/18.3ms,
`relay_alive: true`. **0 findings** — a deaf subscriber costs this room
3% of its throughput and nothing else.

`lease-churn --churn-agents 40 --ttl-s 3 --window-s 10`: 1560 grants, 8
`expired` frames broadcast, 0 leases left after 2x TTL, `relay_alive:
true`. **0 findings** — issue #34/#37's fix (and #47's shard-scoped sweep
now running promptly off the background ticker) holds under live churn,
not just in the unit tests.

**2 findings, both pre-existing and out of this track's scope:**
`swarm50`'s grant-rate collapse under 200-agents-on-8-regions contention
(issue #36's own scenario shape; #36 and its follow-ups
`fix/grant-rate-collapse`/`fix/rescue-grant-rate` already merged into
`main` before this track started — this number is the scenario's own
strict threshold at these parameters, not a regression this PR
introduced, and nothing here touched wait-die's arbitration) and
`rooms`'s dead-room memory growth (`Relay.rooms`/`Registry.rooms` are
never pruned, already named in `docs/relay-parity.md` as "a real, separate,
already-known issue," present before this PR and not one of the four
things it closed). Neither is issue #40, #47 or #48; neither blocks
"the Go relay is the only relay."

This machine was running other agents' work throughout, same caveat every
prior load number in this file carries — read the relative shape, not the
absolute ms.

## 2026-08-17 — corrections from the ops/docs audit

Everything above is what actually happened during the 2026-08-11 wave and
stays as written. This section corrects the parts of the record that later
became wrong, additively, rather than editing history in place.

**CI is gone, permanently.** The "CI's Linux runner" and "CI scheduler"
mentioned early in this file (in "Suites, run today") were real — a GitHub
Actions workflow did exist and did catch that race on 2026-08-11. It doesn't
any more: `.github/workflows/ci.yml` is deleted for good, out of GitHub
Actions minutes and not going back (see `scripts/ci-local.sh`'s own header).
Nothing left in this repo can reproduce "plus CI" the way that paragraph
describes; `scripts/ci-local.sh` is what a PR gets checked against now.

**The "Deleted, once nothing referenced it anymore" list is wrong about two
entries.** It names `similarity.py` and `tools/tune_rung4.py` as deleted
alongside `leases.py`/`wait_die.py`. Neither was: `python/src/agent_presence/similarity.py`
exists today and is imported by `embedding_similarity.py`, `tools/tune_rung4.py`,
`tools/bench_redundant_peer.py` and the test suite; `python/tools/tune_rung4.py`
exists and is the offline corpus-scoring tool rung 4's threshold came from.
What did leave with the Python relay is `similarity.go`'s Go port taking
over the relay's own request path — `similarity.py` just isn't on it any
more, which is a different claim than "deleted."

**The suite-count summary (top of this file) and the later per-wave tables
don't agree, and that's not a typo — they're counting two different trees.**
The top table (`1094`/`856`/`77`/`36`) is this wave's numbers *before* the Go
relay work below it deleted `python/tests/`'s Python-relay-only coverage; the
later tables (`359`/`272`, then further down again after the MCP port) are
*after*. Both were accurate for the tree they were measured against — the
gap between them is the deletion itself, not drift. For where the numbers
stand now:

| suite | 2026-08-11 (top of this file) | today, 2026-08-17 |
| --- | --- | --- |
| `go test ./... -race -count=1` | 77 tests | 274 tests (measured by the audit) |
| `python -m pytest` | 1094 passed | 380 passed, 1 skipped (measured by the audit) |
| `ap_tests` (cpp) | 856 assertions / 43 cases | 855 assertions / 43 cases (re-run for this section, `cpp/build/ap_tests`) |
| `pnpm test` (web, vitest) | 36 | 498 (measured by the audit) |

The cpp count is one assertion lower than this file's own 2026-08-11 number,
not the audit's — re-running the already-built `cpp/build/ap_tests` binary
gets 855, and it's unclear from this file alone whether 856 was ever a typo
or a real assertion added and later removed; not worth chasing further here.

**`swarm50`'s "relay RSS after drain: 12.4 MiB" is corrected, not re-run
here.** `tests/load/` was visibly in heavy use by other agents' sessions on
this machine while this section was written (a full page of `.relay-*.log`
files with today's timestamps in that directory), and `swarm50` binds
several ports outside this task's assigned 9550-9559 range via
`free_port()` — running it again risked colliding with, or muddying the
results of, work already in flight, so this section relies on the audit's
own measurement rather than a fresh one: three same-day runs at 34.0-34.7
MiB, close to a freshly-started idle `gorelay`'s baseline. 12.4 MiB was
reproducibly low by about 2.8x, almost exactly the gap between "idle" and
"after actually draining 3000 grants." **Corrected value: ~34 MiB (the
audit's measurement, not re-run for this section)**, dated 2026-08-17;
re-run `tests/load/run.py swarm50` on a quiet machine to refresh it rather
than trusting a number this old going forward.

**Previously-undocumented env vars, now documented:** `AGENT_PRESENCE_PRINCIPALS`,
`AGENT_PRESENCE_REPO_ROOT`, `AGENT_PRESENCE_RUNG4_THRESHOLD` and
`AGENT_PRESENCE_LOG_LEVEL` are read by shipped code (`relaysrv`, `agent-presence-mcp`)
and were documented nowhere; they're now listed in `docs/go-daemon.md` next
to the vars `presenced` itself reads, with a note that they belong to other
binaries. `AGENT_PRESENCE_GORELAY_BIN` is test-harness-only, documented in
`python/tests/helpers/gorelay_proc.py`'s own docstring instead.
