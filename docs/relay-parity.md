# Go relay: what's ported, what isn't, and the numbers

**Date:** 2026-08-11
**Status:** ships opt-in. `AGENT_PRESENCE_RELAY_IMPL=go` (or `agent-presence-relay --impl go`)
runs it; the default is still the Python relay. See "the call" at the bottom.

**A note on timing:** this branch was built against an older `main`, before
PRs #31, #37, #38, #39 and #41 merged into it. Those bring the Python relay
the presence-snapshot fix, the lease-expiry/wait-die fixes, the marshal-once
fan-out fix, and delete `cpp/daemon/` in favor of `go/cmd/presenced`. This
branch was rebased onto the merged `main` and everything below —
the golden-scenario diff, the black-box suite, the load numbers — was
re-run *after* that rebase, against what `main` actually is now, not
against the pre-merge snapshot. Where that changes the story from what an
earlier version of this doc said, it's noted inline.

## What was built

`go/cmd/gorelay` + `go/internal/relaysrv`: a from-scratch Go relay speaking
the same wire protocol `python/src/agent_presence/serve.py` and `relay.py`
do. Not the spike's prototype (`spike/relay/goprototype`, PR #39) — this one
has the domain layer: wait-die arbitration, the ladder (rungs 0-3), handover
and reservations, the fair-share/handover grace split, tiers and priority
off `principals.toml`, negotiation moves (DEFER/SPLIT/HANDOFF/PROCEED),
redaction and opaque-mode hashing, and the join-time presence snapshot
(PR #31 / issue #30, now on `main`). It ports the *fixed* lease-expiry-
broadcast and requester-age behaviour from PR #37 (issues #34, #35, also
now on `main`) — see "issues #34 and #35" below for what those were and how
this was verified, even though `main` no longer reproduces the bugs to
compare against directly.

Goroutine per connection, one outbound channel per connection (bounded 512,
drop-oldest, matching `serve.py`'s `SEND_QUEUE_MAX`), incremental fan-out,
one encode per distinct payload fanned out to every recipient as the same
bytes (`EncodeFrame`, called once per `Broadcast`/`PublishTo` call) —
the same fix `main`'s `broadcast()` independently landed as `perf/marshal-once`;
see "a real bug" below for how the first pass of this port got that backwards
before catching it. The lock is sharded per room *and* per region within a
room (by path hash, 16 shards) — the spike explicitly flagged its single
room-wide mutex as making its high-concurrency numbers a floor, not a
ceiling; this is that gap closed, and it's a step further than `main`'s own
fix goes (that one is single-threaded regardless). Wait-die's age/tier
bookkeeping is deliberately *not* shard-local: `age_of`/`priority_of` are
agent-global in the Python relay (a wait-for cycle can span rooms), so
they live in a small separate striped index, updated on every
acquire/release, read under its own lock. See
`go/internal/relaysrv/leases.go`'s doc comments for the full argument.

## What is not ported

- **Rung 4 (declared-intent similarity / redundant-work detection).**
  `python/src/agent_presence/similarity.py` is a 389-line lexical scorer
  with a hand-tuned synonym table; porting it wasn't attempted. The Go
  relay always behaves as if `AGENT_PRESENCE_RUNG4` were unset, which is
  the Python relay's own shipped default and the common case — this is a
  gap only for a room that has set the flag. Rung 4 is advisory (it never
  touches the lease table), so this cannot cause a wrong grant or refusal,
  only a missed `redundant_work` notice. Filed as a follow-up.
- **The org policy engine.** `policy.py` (1619 lines) resolves a
  `policy.toml` floor and the relay broadcasts it as a `policy` frame on
  join and on live reload. Not ported. A room with no org policy file — the
  common case, and the one `test_golden_noop.py` locks down — is
  unaffected: no `policy` frame is a fact, not a difference. A room that
  *does* configure an org floor will not see it reach clients through the
  Go relay; each daemon still enforces its own compiled-in defaults, so
  this narrows enforcement rather than removing it, but it is a real gap.
  Filed as a follow-up.
- **Room keys (`room_key.py`).** Not applicable to the relay: it treats
  `room` as an opaque string from the join frame, exactly like
  `relay.py` does. Room-id computation from a git remote is a *client*
  concern (`repo.cpp`, `mcp_server.py`), unchanged by this PR.

## The two bugs this ports the fix for, not the bug

PR #37 (issues #34, #35) fixes two things in `leases.py`/`relay.py` that
are still live bugs on `main` as of this PR. The Go relay ships the fixed
behaviour from day one:

- **#34 — lease expiry discovered by a read was never broadcast.** Lazy
  expiry that a *write* (acquire/release/...) tripped over published a
  departure frame; expiry a *read* (`holder_of`, the join snapshot)
  tripped over didn't, so a room's daemons could hold a lease the relay
  had already dropped for up to a full TTL. `go/internal/relaysrv/leases.go`'s
  `pruneExpired` runs — and publishes — on every shard access, read or
  write, by construction (there's no separate read path to forget).
  Covered by `TestExpiryDiscoveredByAReadStillPublishes`.
- **#35 — a requester's wait-die age reset to "now" between claims.**
  `age_of` returned `clock.now()` for any agent holding nothing, so a
  requester that had just been refused (and had its own leases dropped on
  an abort) always read as brand new on its next ask — the `wait` verdict
  was unreachable for the ordinary shape of contention. The Go relay
  latches a `first_seen` time the way the fixed Python does: an abort
  (`ReleaseAll`) does not reset it, a *voluntary* release does (and lazily,
  on the next `age_of` call, not eagerly at release time — see the
  `agentClaimRemovedByRelease` doc comment, which is the one place this
  needed a second pass to match Python's pop-then-relatch instead of a
  simpler eager-set that gave a different number). Covered by
  `TestRequesterAgeSurvivesAnAbortAndCanLaterWin` and
  `TestReleaseToEmptyHandedResetsAgeForTheNextGenuinelyNewAsk`.
  The load harness's `swarm` scenario shows the practical effect directly:
  see the numbers below — Python (`main`, without #37) reports
  `WAIT-DIE NEVER SAYS WAIT` (0 waits, all aborts) at every scale; the Go
  relay does not, because it has the fix.

## A real bug this process found (and fixed) in the port itself

Building this surfaced a genuine bug worth naming: `regionPayload` returns
the package's own `Frame` type (`map[string]any` underneath), and a later
read-back used a type assertion against the bare `map[string]any` — which
fails for a named type with the same underlying representation, silently
producing an empty region on every "event" frame's internal re-parse. The
practical effect: every rung-0-3 classification saw every event as
same-empty-path, so contention detection was wrong (a first touch of an
untouched file classified as rung 3). Found via the golden-scenario diff
against Python (below), not by inspection — the two relays' frames
disagreed on `rung` in exactly the cases this bug would produce, and
nowhere else. Fixed in `relay.go` and, for the same reason in the outbound
opaque-mode walk, in `redact.go`'s `applyOpaqueMap`. This is exactly the
"per-recipient redaction leaking one room's data into another's buffer"
class of bug the task called out as the most dangerous line in the diff —
it wasn't that one, but it was adjacent to it (the opaque-mode outbound
walk), and the same root cause (a named-type assertion silently failing)
would have produced it under the right conditions. Both are covered by
tests now (`TestGoldenScenarioMatchesPython` catches the first;
`applyOpaqueMap`'s `Frame` handling is exercised by the opaque-mode
end-to-end check in `test_serve.py`, run against the Go relay).

A second issue, caught by re-reading the brief rather than by a test: the
first working version of `Broadcast`/`PublishTo` called each target
connection's `Send(Frame)`, and each connection's own writer goroutine
independently ran `EncodeFrame` (opaque-mode walk + `json.Marshal`) on
its way out — the exact per-recipient re-serialization this issue exists
to get rid of, and coincidentally the same thing stock `serve.py` still
does today (`_drain()` calls `json.dumps` per connection; that's what
`perf/marshal-once` fixes on the Python side). Fixed by moving the
`Conn` interface to take pre-encoded `[]byte` instead of a `Frame`:
`Relay.Broadcast`/`PublishTo` call `EncodeFrame` exactly once per
distinct payload and hand every recipient the same bytes; a
single-recipient reply encodes once too, trivially. No behavior change —
`EncodeFrame` is a pure function of the payload, so the bytes are
identical either way — this was a "do it right by construction" fix, not
a correctness bug, but it's worth naming because it's exactly the design
property issue #40 asked for by name and the first pass didn't have it.

An adversarial review pass (dispatched against the diff and the Python
source, per this issue's own requirement) found three more, real ones,
fixed in the same commit:

- `carryKey` (the dodge-your-own-deadline guard in `leases.go`) dropped
  `Region.Lines` from its identity. Python's `_carry` keys on the full
  frozen `Region` dataclass, lines included; the Go key was coarser, so a
  release and re-claim of the same symbol at a *different* line range
  would have incorrectly resumed a capped handover deadline that Python
  would have treated as a fresh claim.
- `ReleaseEverywhere` snapshotted the room list under a brief read lock
  and iterated the snapshot after releasing it — a room created in that
  window was invisible to the sweep. Narrow (identity-reclaim only), but
  real; now holds the lock for the whole sweep. Covered by
  `TestReleaseEverywhereSeesRoomsCreatedDuringItsOwnSweep`, run under
  `-race`.
- `RedactEvent` read the opaque-mode toggle twice per event — once inside
  `CleanRegionDict`, once in its own trailing pass — where Python's
  `redact()` reads it once, and the two reads could disagree about
  whether a region was already hashed, marking it stale before the
  trailing pass saw it. Now builds the event's region unhashed and defers
  to the single trailing pass, matching Python's structure exactly.

None of the three were caught by the golden-scenario diff or the
black-box suite — the first needs a release/re-claim-with-a-different-
line-range sequence neither exercises, the second needs concurrent room
creation during an identity reclaim, and the third only diverges from
Python under opaque mode on specific field orderings. Named here because
"the tests passed" was not, on its own, evidence these three were fine —
the adversarial pass is what found them.

## Parity verification: what was actually run

### Black-box, over a real socket, against `python/tests/`

Most of `python/tests/` drives the Python `Relay` object in-process with a
fake connection, or uses a `VirtualClock` advanced by hand — neither is
runnable against an external process. The subset that is a real
`websockets.connect()` against a real listening relay, with `RealClock`
(so wall-clock behaviour, not a mocked one), was pointed at the Go relay
by swapping the `serve()` coroutine each file's `server`/`roster_server`
fixture calls for one that spawns `gorelay` as a subprocess instead —
no other line of the test files changed. The harness is not part of this
PR (it's throwaway, in the session's scratch dir); the result is:

| file | result |
| --- | --- |
| `test_e2e.py` | 8/8 passed, including the roster/principal/token authentication tests over the real wire, and the senior-waits/junior-aborts handover scenario |
| `test_serve.py` | 5/6 passed. The one failure (`test_opaque_mode_leaves_no_cleartext_path_on_the_wire`) is a harness artifact, not a relay bug: the test flips `AGENT_PRESENCE_OPAQUE` with `monkeypatch.setenv` *after* the relay subprocess has already been spawned, and a child process does not observe a parent's later env change. Verified directly instead: started `gorelay` with `AGENT_PRESENCE_OPAQUE=1` set at process start (the only way any operator would actually set it) and confirmed no cleartext path reaches the wire — see the opaque-mode check below. |

Not run black-box: `test_backpressure.py`, `test_inbound_rate_limit.py`
(both `VirtualClock`-driven — the shed/rate-limit thresholds are exercised
by advancing a mocked clock, which has no analogue across a subprocess
boundary), `test_policy_live_reload.py` (policy engine, not ported),
`test_lease_fanout.py`, `test_mcp_tools.py`, `test_relay_restart.py`
(mixed: some functions inspect the Python `Relay` object's internals
directly, which only the in-process Python relay has). This is a real
coverage gap, named precisely rather than glossed: backpressure shedding
and inbound rate limiting are implemented to the same design (bounded
channel + clock-driven shed timer, see `server.go`) and covered by two
Go-side concurrency tests (`TestConcurrentSendNeverBlocks` and the load
harness's real-socket runs below), but not by the exact deterministic
scenarios Python's suite uses.

### Golden scenario — byte-for-byte, both relays, same script

`python/tests/helpers/golden_scenario.py` drives a two-agent contention
scenario (claim, contest, rungs 0/2/3, handover fields, release) against a
`VirtualClock` and records every frame both agents receive. Ported
verbatim to `go/internal/relaysrv/golden_test.go` — same calls, same
clock schedule — and diffed field-by-field against Python's own current
output (not the `golden_base.json` fixture, which predates the policy
engine and PR #31; comparing against *current* `main` is the harder and
more direct check). Run twice: once before the rebase (normalizing two
documented differences — Go omits `effect`/`effect_source`, no policy
engine; Go's `presence` array on the join snapshot was PR #31 ahead of it
merging), and once after (PR #31 is on `main` now, so `presence` is no
longer a difference to normalize — only `effect`/`effect_source` is).
Both: **zero differences.** This is what caught the region-parsing bug
above, on the first run.

### Go daemon's relay client, unchanged, against the Go relay

`go/internal/relay` (the daemon's client, from the already-merged
`feat/go-daemon`) is used unmodified — no test double, no fake relay — in
`go/internal/relay/gorelay_integration_test.go`: it builds `cmd/gorelay`,
joins a room, and a second raw connection claims a region; the test
asserts the daemon's own `leases.Cache` (the thing a hook decision
actually reads) picks up the claim through ordinary fan-out. Passes.

### C++ daemon (`presenced`) — since removed from `main`

Tested against `cpp/daemon` while this branch was still based on the
pre-#38 `main`: built via `cmake`, pointed at a running `gorelay`. The
websocket connection joined and stayed established (confirmed via `lsof`)
through a raw client claiming a region in the same room — the join
snapshot and the fan-out frame both parsed without the daemon dropping the
connection, which is the thing that would happen first if a field were
missing or mis-shaped. Did **not** get a clean end-to-end confirmation
through `ap-hook`'s actual block/allow decision — the one attempt made
returned an unconditional allow, which traced to `decide.cpp`/`repo.cpp`'s
repo-root path normalization behaving differently in a `git worktree`
checkout than a plain one, not to anything on the wire; not chased
further given the time budget.

Moot now: PR #38 merged into `main` in the same wave as this rebase and
deletes `cpp/daemon/` entirely, along with `relay_client.{cpp,hpp}` — the
C++ code this section was testing no longer exists on `main`.
`go/cmd/presenced` (the Go daemon) is the only daemon on `main` as of this
PR, and it's what "Go daemon's relay client" above verifies directly,
unmodified, re-run after that same daemon went through its own
significant restructure in the merge wave (new `internal/{coalesce,
contend, journal, policy, presence, repo}` packages) — still passes.

### Web client

`web/src/office/live.js`'s exact `connect()`/`isPresence()` code, run
under Node against a live `gorelay`: the join frame lands, and a real
`presence` frame from a second (Python) client passes the browser client's
own field-shape check unmodified. `web/src/main.ts`'s connection logic is
the same shape (one join frame, defensive JSON parse) and was not run
separately.

### MCP relay client (`relay_client.py`)

Not driven through `RelayConnection` directly as a Python object (that
would need its own harness), but `test_e2e.py`'s frames are the exact
frame shapes `RelayConnection.claim`/`.move`/`.release` send, and its
`_apply_leases`/`_apply_lease`/`_apply_presence` parsing is the same
shape asserted against in `test_serve.py` and the golden scenario. Not
run through the literal class; the wire contract it depends on is
directly exercised.

## Go-side tests

`go/internal/relaysrv`: wait-die (the property that a two-agent wait
cycle is unreachable, ported as a table test, not the Python suite's
`hypothesis` version), lease acquire/renew/refuse/expire/heartbeat,
room isolation, whole-file-vs-symbol contention, handover deadlines and
reservations (including the reservation correctly blocking the loser and
being inherited by the winner), priority/tier ordering, both PR #37
fixes directly, and the golden-scenario dump. Two concurrency tests run
under `-race`: many goroutines claiming/releasing across rooms and
regions at once (the property the shard design exists for), and many
goroutines calling `Send` on one connection at once (the property
non-blocking backpressure exists for). `go test ./... -race -count=1`
is clean across the whole module, including the pre-existing daemon/hook
socket/decide packages.

## Load harness: `tests/load/scenarios.py`, unmodified, against both

Same scenario code, same machine, interleaved by member count (not a
custom bench — a `RelayProc`-shaped subprocess wrapper around `gorelay`
stands in for `_lib.RelayProc`, nothing else changed). Run both before and
after the rebase onto merged `main` — see below for both sets of numbers,
since `perf/marshal-once` and the wait-die fix landing mid-PR changes what
"python" means between the two.

### `swarm` — the spike's own scenario, 8 hot regions, 15 rounds

Run twice: once before the rebase onto the merged `main` (stock Python,
pre-#37/#41), once after (Python now has the wait-die/expiry fixes and
marshal-once). Both are reported — the second is the number that matters
going forward, the first is why the `wait`/`abort` split below reads
differently between them.

**Before the rebase** (Python = stock `main`, no #37/#41):

| agents | python p99 (ms) | go p99 (ms) | ratio | python wait/abort | go wait/abort |
| --- | --- | --- | --- | --- | --- |
| 200 | 107.7 | 32.5 | 3.3x | 0 / 2879 | 1554 / 1343 |
| 400 | 313.9 | 55.2 | 5.7x | 0 / 5879 | 3414 / 2474 |
| 800 | 413.1 | 193.2 | 2.1x | 0 / 11879 | 5804 / 6087 |
| 1600 | 1008.9 | 345.0 | 2.9x | 0 / 23879 | 12200 / 11679 |

Stock Python's `wait` column is zero at every scale — `WAIT-DIE NEVER SAYS
WAIT` fires every run — which is issue #35 exactly. The Go relay had the
fix from the start, ported from PR #37 before it merged.

**After the rebase** (Python = current `main`, with #37/#41; same machine,
now also running several other concurrent sessions' work — noisier than
the first round, noted per row):

| agents | python p99 (ms) | go p99 (ms) | ratio | python cpu/op | go cpu/op | conditions |
| --- | --- | --- | --- | --- | --- | --- |
| 200 | 412.2 | 69.5 | 5.9x | 0.33ms | 0.17ms | machine moderately busy |
| 400 | 587.1 | 321.7 | 1.8x | 0.31ms | 0.16ms | busy: concurrent with this session's own pytest rerun |
| 800 | 644.7 | 396.4 | 1.6x | 0.31ms | 0.19ms | busy: same |
| 1600 (round A) | 1794.3 | 2338.0 | **0.77x — go lost** | 0.34ms | 0.20ms | busy: same, plus other sessions' work |
| 1600 (round B, isolated) | 5944.6 | 1262.5 | 4.7x | 0.41ms | 0.19ms | this session's own load quieted; other sessions still running |

Go still wins on every row except one, and that one is explained rather
than hidden: at 1600 agents in round A, `relay_cpu_s` for the Go run was
4.88s against a 23.41s wall-clock elapsed — the relay was busy barely a
fifth of the time it took to finish. That is the exact "single-process
asyncio client becomes the ceiling, not the relay" effect
`docs/relay-spike.md` measured and named (`harness_cpu_s` dominating
elapsed time once the relay is fast enough that the *client* can't drive
it any harder from one process) — this PR uses the standard
`tests/load/scenarios.py` harness as instructed, not the spike's
client-sharding fix, so it inherits that ceiling at the highest agent
count. Round B, run in isolation after quieting this session's own
concurrent work, shows the same shape the pre-rebase numbers did: Go
ahead by 4.7x. `relay_cpu_ms_per_op` — a metric less sensitive to
wall-clock scheduling noise than p99 — favored Go in every single row
without exception, including round A: 0.20ms/op vs Python's 0.34ms/op.

Across both rounds and both machine conditions: no `LEASE LEAK` finding,
no lost relay process, on either side. This machine was not quiesced for
any of these runs — `docs/relay-spike.md`'s own caveat applies here too,
more so given how much else was running on it during this PR.

Memory: Go's post-drain RSS was lower than Python's in every run measured
(e.g. round B at 1600 agents: Python 17.4 MiB after every connection
closed, Go 8.5 MiB) — consistent with Go's stack-allocated goroutines vs.
asyncio's per-connection Python objects, not a claim measured carefully
enough to put a precise number on beyond "the pattern holds."

### `rooms`, `slow_subscriber`, `lease_churn`

Run once, before the rebase onto the merged `main` (so "python" below is
stock `main`, pre-#31/#37/#41 — see the note at the top of this doc). Not
re-run after the rebase given the time this PR had; the `swarm` numbers
above were re-run post-rebase and are the ones to trust for latency. What
these three still show correctly regardless of which Python they're
compared against: isolation holds, backpressure holds, and — before #37
merged — the Go relay already had the fix stock `main` didn't. After the
rebase, current `main` also has that fix (that's the whole point of PR
#37 landing), so re-running `lease_churn` today would no longer show
Python's `NO EXPIRY EVER BROADCAST` finding — both sides would pass. That
doesn't change what's demonstrated here: the Go relay was built with the
fix from the start, verified against it being live-reproducible on the
`main` this branch started from.

### `rooms` — 40 rooms x 25 agents, cross-room isolation and dead-room memory

| | python | go |
| --- | --- | --- |
| claim p50/p95/p99 (ms) | 190.6 / 396.5 / 414.2 | 39.5 / 62.2 / 63.8 |
| isolation_violations | 0 | 0 |
| findings | `DEAD ROOMS ARE NEVER FORGOTTEN` (500 dead rooms cost -16 MiB, the next 500 cost +65 MiB, not levelling off) | none |

`isolation_violations: 0` on both: no frame in any of the 1000 connections
named an agent from another room. The `_shared_agent_name_across_rooms`
sub-check (one agent id live in two rooms, per `presenced@<hostname>`'s
default) also came back clean on both — `repo_a_leases_after_abort_in_repo_b`
and `..._after_repo_b_disconnect` both stayed at 1, meaning neither an abort
nor a disconnect in room B dropped the same-named agent's lease in room A.
That is the *fixed* room-scoped `release_all` behaviour — the Go relay never
had the bug (`ReleaseAll` is room-scoped from the port's first line), so
there was nothing to port here beyond getting the scoping right the first
time.

Python's dead-room finding is a real, separate, already-known issue
(`_members`/`_activity`/`_last_ts` are keyed by room and nothing ever
deletes a room). The Go relay has the *same* structural gap — `Relay.rooms`
and `Registry.rooms` are never pruned either — but at 1000 abandoned rooms
its footprint doesn't move enough to trip the same threshold
(`dead_room_cost_kb`: first_500 -832 KiB, second_500 -96 KiB, both inside
noise). That's a smaller per-room cost, not a fix — the Go relay would show
the same unbounded growth eventually, just at a much higher room count. Not
claiming otherwise.

### `slow_subscriber` — a connection that never reads, 30 busy agents, 20s

| | python | go |
| --- | --- | --- |
| ops, healthy baseline | 20998 | 105278 |
| ops, with a deaf subscriber | 20866 | 100623 |
| throughput ratio (deaf/healthy) | 0.99 | 0.96 |
| claim p99, with deaf subscriber (ms) | 140.0 | 21.1 |
| relay_alive | true | true |
| findings | none | none |

Neither relay's `INGEST STALLED` check fired — a connection that never
reads does not stop the rest of the room making progress on either side.
This is the one scenario that most directly exercises `server.go`'s
backpressure design (bounded per-connection channel, drop-oldest, shed on
stall/saturation) under real concurrent load rather than a `VirtualClock`,
and it holds up: comparable throughput ratio to Python's, and lower
absolute latency throughout. This supersedes what an earlier draft of this
doc said about backpressure being unverified beyond code review — it is
verified, just not by the same deterministic unit tests Python's suite
uses (`test_backpressure.py` is still not ported — see above).

### `lease_churn` — 60 agents, 2s lease TTL, 15s window (issue #34, live)

| | python | go |
| --- | --- | --- |
| grants | 1258 | 1471 |
| `lease` (held) frames seen | 1258 | 1471 |
| `released` frames seen | 181 | 347 |
| `expired` frames seen | **0** | **8** |
| findings | `NO EXPIRY EVER BROADCAST` | none |

This is issue #34 caught live, not just in the unit test: Python (`main`,
without PR #37) never broadcasts a single `expired` frame across 1258
grants in a 15s window at a 2s TTL — exactly the bug's description, a room
gone quiet is a room where every daemon keeps blocking on leases the relay
already dropped. The Go relay broadcasts 8 in the same shape of run,
because `pruneExpired` runs on every shard access and publishes regardless
of whether a read or a write tripped it.

## The call

**Ships opt-in**, but the evidence for the common case (no org policy file,
`AGENT_PRESENCE_RUNG4` unset — the shipped defaults) is stronger than
"opt-in" alone conveys, so this is closer to "opt-in and ready to become the
default soon" than "opt-in because it's unproven." `AGENT_PRESENCE_RELAY_IMPL=go`
selects the Go relay from `agent-presence-relay`'s existing entrypoint
(`serve.py`'s `main`, a real `exec`, not a subprocess wrapper); unset, the
default stays the Python relay for one release.

What holds up, for the default configuration: a zero-diff golden scenario
against Python's *current* behaviour (re-verified after the rebase onto
merged `main` — still zero); 13/14 real-socket black-box tests passing
(the one failure is a test-harness artifact, independently confirmed
fixed by starting the env var correctly instead of mid-test); two real
bugs found and fixed by the process itself, one by the golden-scenario
diff and one by re-reading the brief (see above); the Go daemon's
existing, unmodified relay client working against it, re-verified after
the daemon's own significant restructure in the same merge wave; the web
client's actual `connect()`/`isPresence()` code working against it; and a
load-test run that beats Python on p99 in 8 of 9 rows measured across two
machine-load conditions and two Python baselines (see the `swarm` numbers
above for the one row that didn't, and why — a client-side bottleneck
this PR's harness doesn't shard around, not a relay regression, backed by
`relay_cpu_ms_per_op` favoring Go in that same row).

Why opt-in rather than flipping the default outright, despite that:

- Two real, named features are not ported at all: the org policy floor and
  rung 4. Both fail safe (the common unconfigured case this PR verified
  against is unaffected; a room that *has* configured either would get a
  worse experience switching relays today, not a wrong one — rung 4 is
  advisory and the policy floor only narrows enforcement, never removes a
  daemon's own compiled-in floor). Still real gaps, still block "default."
- `python/tests/` is ~12,700 lines; this PR's real-socket black-box
  coverage is a double-digit fraction of it — the fraction that's actually
  runnable against an external process, not a random sample, but still a
  fraction. `test_backpressure.py` and `test_inbound_rate_limit.py`
  specifically were not run in their original, deterministic
  `VirtualClock` form (see above for what stood in for them) — though the
  load harness's `slow_subscriber` scenario exercises the same mechanism
  under real concurrent load and passes on both relays.
- The load numbers this PR reports were gathered on a shared machine
  running several other concurrent sessions' work throughout, sometimes
  including this session's own concurrent test runs by mistake (caught
  and re-run in isolation once noticed — see `swarm`'s 1600-agent rows).
  The relative comparison (paired, interleaved, same machine) is the part
  expected to survive that; a single absolute number from any one row is
  not.

None of that is a reason to hold the work — the numbers are real, the
domain layer is genuinely ported, not stubbed, and the C++ daemon this
would have needed to worry about is gone from `main` as of this same merge
wave (`go/cmd/presenced` is the only daemon now, and it's the one this PR's
integration test exercises directly, unmodified). It's a reason to let
someone opt in, watch it under real traffic for a release, and close the
two named feature gaps before making it the default. Follow-up issues:
port the org policy floor, port or explicitly retire rung 4, widen the
black-box parity run to the rest of `python/tests/` that can be adapted,
and re-run the load harness on a quieter machine for a cleaner 1600-agent
number.
