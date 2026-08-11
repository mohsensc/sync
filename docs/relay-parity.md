# Go relay: what's ported, what isn't, and the numbers

**Date:** 2026-08-11
**Status:** ships opt-in. `AGENT_PRESENCE_RELAY_IMPL=go` (or `agent-presence-relay --impl go`)
runs it; the default is still the Python relay. See "the call" at the bottom.

## What was built

`go/cmd/gorelay` + `go/internal/relaysrv`: a from-scratch Go relay speaking
the same wire protocol `python/src/agent_presence/serve.py` and `relay.py`
do. Not the spike's prototype (`spike/relay/goprototype`, PR #39) — this one
has the domain layer: wait-die arbitration, the ladder (rungs 0-3), handover
and reservations, the fair-share/handover grace split, tiers and priority
off `principals.toml`, negotiation moves (DEFER/SPLIT/HANDOFF/PROCEED),
redaction and opaque-mode hashing, and the join-time presence snapshot
(PR #31 / issue #30). It ports the *fixed* lease-expiry-broadcast and
requester-age behaviour from PR #37 (issues #34, #35), not the bugs those
fixed — see "issues #34 and #35" below.

Goroutine per connection, one outbound channel per connection (bounded 512,
drop-oldest, matching `serve.py`'s `SEND_QUEUE_MAX`), incremental fan-out.
The lock is sharded per room *and* per region within a room (by path hash,
16 shards) — the spike explicitly flagged its single room-wide mutex as
making its high-concurrency numbers a floor, not a ceiling; this is that
gap closed. Wait-die's age/tier bookkeeping is deliberately *not*
shard-local: `age_of`/`priority_of` are agent-global in the Python relay
(a wait-for cycle can span rooms), so they live in a small separate
striped index, updated on every acquire/release, read under its own lock.
See `go/internal/relaysrv/leases.go`'s doc comments for the full argument.

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
tests now (`TestGoldenScenarioDumpsForComparison` catches the first;
`applyOpaqueMap`'s `Frame` handling is exercised by the opaque-mode
end-to-end check in `test_serve.py`, run against the Go relay).

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
more direct check). Result, after normalizing the two known,
already-documented differences (Go omits `effect`/`effect_source` — no
policy engine; Go adds `presence` to the join snapshot — PR #31, not yet
on `main`): **zero differences.** This is what caught the region-parsing
bug above.

### Go daemon's relay client, unchanged, against the Go relay

`go/internal/relay` (the daemon's client, from the already-merged
`feat/go-daemon`) is used unmodified — no test double, no fake relay — in
`go/internal/relay/gorelay_integration_test.go`: it builds `cmd/gorelay`,
joins a room, and a second raw connection claims a region; the test
asserts the daemon's own `leases.Cache` (the thing a hook decision
actually reads) picks up the claim through ordinary fan-out. Passes.

### C++ daemon (`presenced`)

Built via `cmake` and pointed at a running `gorelay`. The websocket
connection joins and stays established (confirmed via `lsof`) through a
raw client claiming a region in the same room — the join snapshot and the
fan-out frame both parse without the daemon dropping the connection, which
is the thing that would happen first if a field were missing or
mis-shaped. Did **not** get a clean end-to-end confirmation through
`ap-hook`'s actual block/allow decision — the one attempt made returned an
unconditional allow, which traces to `decide.cpp`/`repo.cpp`'s repo-root
path normalization behaving differently when run from a `git worktree`
(this checkout) than a plain checkout, not to anything on the wire; not
chased further given the time budget. Flagged, not swept under anything:
the C++ daemon's wire-level join and fan-out are verified; a full
hook-decision round trip through it is not. `cpp/daemon` is also the thing
PR #38 deletes, so this gap has a shrinking blast radius on its own.

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
stands in for `_lib.RelayProc`, nothing else changed). `perf/marshal-once`
has not merged to `main` as of this PR, so "python" below is stock,
un-fixed `main` — the same baseline the spike measured.

### `swarm` — the spike's own scenario, 8 hot regions, 15 rounds

| agents | python p50/p95/p99/max (ms) | go p50/p95/p99/max (ms) | p99 ratio | python cpu/op | go cpu/op | python wait/abort | go wait/abort |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 200 | 69.3 / 105.1 / 107.7 / 116.1 | 10.1 / 24.3 / 32.5 / 33.6 | 3.3x | 0.37ms | 0.233ms | 0 / 2879 | 1554 / 1343 |
| 400 | 162.1 / 306.1 / 313.9 / 352.9 | 21.8 / 48.6 / 55.2 / 57.4 | 5.7x | 0.437ms | 0.238ms | 0 / 5879 | 3414 / 2474 |
| 800 | 328.4 / 408.2 / 413.1 / 423.0 | 78.9 / 188.1 / 193.2 / 195.0 | 2.1x | 0.415ms | 0.248ms | 0 / 11879 | 5804 / 6087 |
| 1600 | 793.7 / 980.4 / 1008.9 / 1016.3 | 133.0 / 232.3 / 345.0 / 458.7 | 2.9x | 0.465ms | 0.288ms | 0 / 23879 | 12200 / 11679 |

Go beat Python at every scale, by 2.1x-5.7x on p99, using less relay CPU
per operation throughout. The `wait`/`abort` split is the practical
evidence for issues #34/#35's fix landing correctly: Python (`main`,
without PR #37) reports zero `wait` verdicts at every scale — the
`WAIT-DIE NEVER SAYS WAIT` finding fires every time — while the Go relay
routinely tells 40-50% of refused agents to `wait` instead of `abort`.
Neither relay leaked a lease (no `LEASE LEAK` finding) or lost the relay
process (`relay.alive()` held) at any scale.

Memory: Go's post-drain RSS was consistently lower than Python's (e.g. at
1600 agents: Python 39.1 MiB after every connection closed, Go 10.7 MiB) —
consistent with Go's stack-allocated goroutines vs. asyncio's per-connection
Python objects, not a claim this PR measured carefully enough to put a
number on beyond "the raw pattern is favorable."

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
against Python's *current* behaviour; 13/14 real-socket black-box tests
passing (the one failure is a test-harness artifact, independently
confirmed fixed by starting the env var correctly instead of mid-test);
a real bug found and fixed by the diff itself (see above); the Go daemon's
existing, unmodified relay client working against it; the web client's
actual `connect()`/`isPresence()` code working against it; and a load-test
run that never regresses and wins by 2-6x on p99 at every scale, with two
of the four load scenarios directly reproducing issues #34 and #35 as *live*
behavioral differences (Python drops every `expired` broadcast and never
once says `wait`; the Go relay does neither), and the backpressure scenario
(`slow_subscriber`) showing a deaf connection doesn't stall the room on
either relay, at noticeably lower latency on the Go side.

Why opt-in rather than flipping the default outright, despite that:

- Two real, named features are not ported at all: the org policy floor and
  rung 4. Both fail safe (the common unconfigured case this PR verified
  against is unaffected; a room that *has* configured either would get a
  worse experience switching relays today, not a wrong one — rung 4 is
  advisory and the policy floor only narrows enforcement, never removes a
  daemon's own compiled-in floor). Still real gaps, still block "default."
- The C++ daemon's wire-level join and fan-out are confirmed (established
  connection, no protocol-driven disconnect); a full hook-decision round
  trip through it isn't, for a reason that traces to local repo-root path
  handling in a `git worktree` checkout rather than the wire, but wasn't
  run to ground given the time this PR had.
- `python/tests/` is ~12,700 lines; this PR's real-socket black-box
  coverage is a double-digit fraction of it — the fraction that's actually
  runnable against an external process, not a random sample, but still a
  fraction. `test_backpressure.py` and `test_inbound_rate_limit.py`
  specifically were not run in their original, deterministic
  `VirtualClock` form (see above for what stood in for them).

None of that is a reason to hold the work — the numbers are real, the
domain layer is genuinely ported, not stubbed, and two live-fire load
scenarios independently reproduced the exact bugs #34/#35 describe on
Python and showed the Go relay free of both. It's a reason to let someone
opt in, watch it under real traffic for a release, and close the two named
feature gaps before making it the default. Follow-up issues: port the org
policy floor, port or explicitly retire rung 4, chase the C++ daemon
hook-decision gap to ground, and widen the black-box parity run to the
rest of `python/tests/` that can be adapted.
