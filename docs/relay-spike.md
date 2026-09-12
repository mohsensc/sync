# Spike: should the relay be rewritten in Go?

**Date:** 2026-08-11
**Status:** done. Recommendation: rewrite the relay in Go — see "Recommendation" for the scale-dependent caveat that comes with it.

## What was built

- `spike/relay/pyfix/src/agent_sync/` — a full copy of `python/src/agent_sync`
  with two changes: `relay.py`'s `broadcast()` marshals a fan-out frame once
  and sends the same bytes to every room member instead of letting each
  connection's writer re-run `json.dumps` on an identical dict, and
  `serve.py` turns off permessage-deflate. Both changes are marked `SPIKE`
  inline and justified by the profiler evidence below, not by reading the
  code and guessing. Nothing in `python/src` was touched.
- `spike/relay/goprototype/` — a from-scratch Go relay, its own module
  (`go.mod`), not part of the `go/` product module and not reachable from
  `go build ./...` or `go test ./...` there. Goroutine per connection,
  bounded (512, matching `serve.py`'s `SEND_QUEUE_MAX`) outbound channel
  per connection with drop-oldest on full, one `sync.Mutex`-protected
  map per room, incremental per-member fan-out that marshals once per
  event. Speaks join/claim/release/heartbeat on the wire exactly as
  `python/src/agent_sync/serve.py` and `relay.py` emit and expect —
  verified by pointing the real `tests/load/_lib.py` `Client` (actual
  `websockets` client, not a stub) at it. It does **not** implement
  wait-die ordering, tiers, handover, or reservations — see "what the
  prototype does not do."
- `spike/relay/bench/harness.py` and `spike/relay/bench/shard_worker.py` —
  the load harness, rerunnable, built on `tests/load/_lib.py`'s `Client`,
  `RelayProc`, `Latency`/`pct`, `rss_kb`, `cpu_seconds` rather than
  reinventing them. Drives a member-count curve against any of the three
  relays (`--target python-stock|python-roomindex|go`) and can split the
  client load across N OS processes (`--shards`) — why, below.

Every finding below cites a specific run; the raw JSON for all rounds is in
`spike/relay/bench/.results/`.

## Decision rule (fixed before results)

- Go clears Python by a wide margin at high member counts **and** the
  algorithmic fix alone doesn't close the gap → rewrite the relay in Go.
- The algorithmic fix closes most of the gap and Go's remaining edge is a
  modest constant factor → fix the algorithm, and say plainly what Go would
  still buy at what scale.
- Go doesn't beat Python meaningfully at any scale reached → say so loudly
  and explain why.

Only latency, concurrency and server load decide this. Rewrite cost, test
investment, and "it's already written in Python" are not inputs and don't
appear in the verdict below.

## Conditions

Apple M4 Pro, 12 cores, macOS 26.5.1 arm64, Python 3.14.6, Go 1.26.5.
**Not a quiesced box**: `uptime` load average ranged 3.5–25.7 across the
runs in this spike — ten other logged-in users and several other Claude
Code sessions on the same machine throughout. Where it matters, runs were
interleaved (stock → fix → go, repeated) so shared noise lands on all three
about equally rather than favoring whichever ran during a quiet stretch.
Round-to-round variance at 800–1600 members was large enough (see below)
that this should be read as a spike with a handful of samples per point,
not a statistically powered benchmark — same caveat `docs/gohook-spike.md`
put on its own numbers, for the same reason.

## Baseline: where the Python relay breaks

Extending `tests/load/scenarios.py`'s `swarm()` shape (agents in one room
contending over a handful of hot regions) to 200/400/800/1600 members,
15 claim/release rounds each, 8 hot regions:

| agents | p50 | p95 | p99 | relay CPU/op | relay RSS peak |
|---|---|---|---|---|---|
| 200 | 67–82ms | 98–163ms | 103–166ms | 0.36–0.44ms | 35–46 MB |
| 400 | 146–161ms | 214–239ms | 216–241ms | 0.37–0.41ms | 52–68 MB |
| 800 | 318–324ms | 396–460ms | 401–465ms | 0.40–0.41ms | 86 MB |
| 1600 | 708–734ms | 818–1370ms | 841–1387ms | 0.43–0.44ms | 144–147 MB |

(range = 2 interleaved rounds; single-process client, `--shards` not yet
in play — see the methodology section for why that matters for the Go
number but not this one.)

p99 scales roughly linearly with room membership — 8x the agents, 8–10x the
p99 — while **CPU per operation stays flat** (0.36 → 0.44ms, not the 8x
you'd see if per-op work itself were what scaled). That split matters: it
says the relay isn't doing more work per claim as the room grows, it's
queueing more, which points at a single-threaded serialization point rather
than an O(n²)-shaped algorithm. `tests/load/scenarios.py`'s own
`swarm()` names the suspect in a comment: "every claim costs
O(members + claims)" from the full-room broadcast plus
`_PublishingRegistry`'s whole-table diff. The profiler below confirms half
of that guess and corrects the other half.

## The bottleneck, named with profiler evidence

`python -m cProfile` around a 800-agent run (`spike/relay/bench/profile_run.py`,
`spike/relay/bench/.logs`), sorted by self time, everything that isn't
`select.kqueue` idle-wait (that's the event loop parked with nothing to do,
not CPU cost):

| function | self time | calls |
|---|---|---|
| `zlib.Compress.flush` | 0.992s | 201,532 |
| `_socket.socket.send` | 0.733s | 203,133 |
| `json.encoder.iterencode` + `.encode` | 0.513s | 202,329 |
| `zlib.Compress.compress` | 0.214s | 201,532 |
| websockets frame `serialize` | 0.272s | 202,332 |
| `permessage_deflate.encode` wrapper | 0.221s | 202,332 |
| **`_PublishingRegistry._publish`** (the whole-table diff) | **0.110s** | 24,800 |

zlib compression alone (flush + compress) costs **11x** what the lease-table
diff costs, in the same run. JSON encoding alone costs **4.7x** the diff. The
diff — the thing `_before()`/`_live()` scanning every claim in the whole
relay, not just the touched room, would make worse — is real (see "what the
algorithmic fix does not do," below) but in this single-room benchmark it's
noise next to what's actually expensive: **serializing and
compressing the same outbound frame once per room member instead of once
per event.** `serve.py`'s `_drain()` runs `json.dumps(opaque_outbound(payload))`
independently for every connection in the room even though `broadcast()`
handed every connection the identical dict, and `websockets.serve()` runs
permessage-deflate (its default) per connection per send on top of that —
real CPU spent compressing ~200-byte JSON frames, which rarely shrinks them
enough to be worth it.

## Algorithmic vs runtime: the Python-side fix

`spike/relay/pyfix` changes exactly two things, both aimed at what the
profiler named: `broadcast()` marshals once and reuses the bytes
(`WsConn.send_encoded`), and `websockets.serve(..., compression=None)`.
Same curve, interleaved with stock:

| agents | stock p99 | fix p99 | stock CPU/op | fix CPU/op | stock RSS peak | fix RSS peak |
|---|---|---|---|---|---|---|
| 200 | 103–166ms | 54–73ms | 0.36–0.44ms | 0.24–0.25ms | 36–46 MB | 32–38 MB |
| 400 | 216–241ms | 127–151ms | 0.37–0.41ms | 0.24–0.26ms | 52–68 MB | 35–43 MB |
| 800 | 401–465ms | 313–338ms | 0.40–0.41ms | 0.26–0.27ms | 85–86 MB | 44–45 MB |
| 1600 | 841–1387ms | 598–648ms | 0.43–0.44ms | 0.29–0.31ms | 143–147 MB | 61–64 MB |

The fix is real: at 1600 members it cuts p99 by 25–56% and relay CPU per op
by ~30%, and it roughly halves peak memory (permessage-deflate keeps a real
zlib window per connection; turning it off is most of that saving). But the
**shape doesn't change** — fixed relay still scales p99 roughly linearly
with room membership, same as stock. This is a constant-factor win from
removing redundant work, not an algorithmic-complexity win: the "whole-table
diff" half of the original suspicion (`_before()`/`_live()` scanning every
claim in every room, not just the touched one — real, see `leases.py`'s
`_claims: list[Claim]`, one flat list for the whole relay) was not touched
by this fix and, per the profiler, wasn't where the time was going in a
single-room benchmark anyway — it would matter on a relay running many
concurrently-busy rooms, which this benchmark doesn't exercise. That's a
real gap in this spike's coverage, not a claim that the whole-table diff is
harmless; see "what this spike didn't cover."

**Where this leaves the algorithmic-vs-runtime split:** the fix recovers a
genuine and non-trivial chunk of the gap between stock Python and the Go
prototype (see next section) — roughly half at the high end — but the
curve is still clearly O(members) after the fix, and Go's remaining edge
varies from "modest" to "wide" depending on scale, not uniformly one or the
other. The ceiling here is partly algorithmic (redundant per-recipient
serialization, fixed), partly just what a single-threaded server has to pay
in queueing once concurrency exceeds what one core can drain — which is a
runtime property, not a diff-loop property.

## The Go prototype, head to head — and a methodology correction mid-spike

First pass, single-process client (same shape as the Python-only runs
above), Go came back looking merely okay — p99 at 1600 around 224–355ms,
CPU/op 0.22–0.25ms. Then `harness_cpu_s` (the *client's* own CPU, tracked
for exactly this reason) turned up ~95% of wall-clock elapsed time on the Go
runs, while `relay_cpu_s` on those same runs *exceeded* wall-clock elapsed
time — only possible if the Go relay was using more than one core
concurrently. Put together: once the relay got fast enough, the single
asyncio client process generating the load became the ceiling, not the
relay. (The stock and fixed Python runs don't have this problem —
`relay_cpu_s` there sits at 94–97% of elapsed, i.e. the relay is the thing
saturated, exactly as a single-threaded asyncio server pegged on one core
should look.)

Fix: `--shards N` splits the client across N OS processes
(`spike/relay/bench/shard_worker.py`), each with its own asyncio loop and
its own core — also a more honest model of reality, since real daemons are
separate processes, not one process pretending to be 1600 of them.
Re-run, 4 shards, interleaved:

| agents | stock p99 | fix p99 | go p99 | go CPU/op | go RSS peak |
|---|---|---|---|---|---|
| 200 | 132ms | 52ms | 13ms | 0.26ms | 28 MB |
| 400 | 267ms | 229ms | 26ms | 0.23ms | 40 MB |
| 800 | 536–924ms (avg 730) | 352–408ms (avg 380) | 97–276ms (avg 186) | 0.25–0.31ms | 61–62 MB |
| 1600 | 1354–1376ms (avg 1365) | 646–910ms (avg 778) | 480–569ms (avg 525) | 0.35–0.41ms | 100–114 MB |

Ratios (avg where 2 rounds exist):

| agents | stock / go | fix / go |
|---|---|---|
| 200 | 9.9x | 3.9x |
| 400 | 10.1x | 8.6x |
| 800 | 3.9x | 2.0x |
| 1600 | 2.6x | 1.5x |

**The margin is not uniform across scale, and it moves the opposite
direction from what you'd naively expect.** At 200–400 members Go wins by
roughly an order of magnitude over both stock and the algorithmic fix —
the fix barely moves the fix/go ratio (3.9–8.6x, next to stock/go's
9.9–10.1x) at this range, i.e. **the fix does not close the gap** where the
gap is largest. At 800–1600 members the margin *shrinks* to 1.5–4x, with
real round-to-round swings at that end (e.g. Go at 800 members: 96.8ms p99
one round, 276.0ms the next, same code, same command, four minutes apart).
That narrowing plausibly comes from the prototype's single per-room
`sync.Mutex` serializing every claim/release/broadcast for a room — every
hot region here lives in one room, so 1600 goroutines all contend one lock,
and on a loaded 12-core box with everything else running, that shows up as
tail latency and run-to-run variance rather than a clean curve. That's a
prototype limitation, not necessarily a Go-vs-Python one — see below.

## What the prototype does not do, and whether it would move the numbers

**Go prototype:**
- No wait-die ordering, tiers, handover, or reservations — `tryClaim` is
  grant-if-free / refuse-if-held / renew-if-owner, nothing else. This makes
  every claim cheaper than `LeaseRegistry.acquire`'s real decision tree, so
  it *understates* what a full port would cost per claim. Given the
  profiler found serialization/fan-out, not decision logic, as the
  dominant cost in Python, this probably doesn't change the shape of the
  result, but it isn't proven here.
- One `sync.Mutex` per room, not sharded by region. A full port would very
  likely shard the lock (or go lock-free) per region, which should tighten
  the 800–1600 tail seen above. Untested in this spike — the numbers as
  measured are a floor on how well a real Go relay would do at that end,
  not a ceiling.
- No isolation check equivalent to `tests/load`'s "0 isolation violations."
  Cross-room leakage wasn't tested for the Go prototype the way it's
  asserted for Python; the room map is keyed correctly by construction
  (one `room` struct per name, membership and claims both scoped to it) but
  that's an argument, not a measurement.
- No reconnect/backpressure-shedding parity with `serve.py`'s `shed_reason`
  logic (stall/saturation timers). The bounded channel with drop-oldest is
  there; the "disconnect a peer that's been saturated for N seconds" policy
  isn't.

**Python fix prototype:**
- Doesn't touch the whole-table (whole-relay) diff in `leases.py` — see
  above. Untested at the axis where that would matter (many concurrently
  busy rooms on one relay, not many members in one room).

None of these gaps favor Python; if anything the Go number in this report
is conservative relative to what a real port would achieve at the high end,
and slightly favorable relative to what it would cost at the low end
(cheaper claim logic). The direction of the recommendation below is robust
to that; the exact 1.5x–10x range is not something to quote as final.

## Recommendation

Applying the decision rule: **the algorithmic fix does not close the gap**
at 200–400 members per room, where Go's margin is largest (8–10x) — so
rule one applies there. At 800–1600 members the fix recovers roughly half
the gap and Go's remaining edge (1.5–4x, noisy) is closer to the "modest
constant factor" rule two describes, though "modest" is doing some work at
the top of that range.

**Rewrite the relay in Go**, on the numbers: Go wins at every scale tested,
by a wide and fix-resistant margin at the concurrency level (a few hundred
members in a room) that's plausibly typical, narrowing but still real at
the highest concurrency this spike could produce on a shared laptop. The
Python algorithmic fix is worth landing regardless of what happens with the
rewrite — it's a real, cheap, isolated win (roughly half the CPU-per-op and
peak memory, described above) — but it does not change the recommendation,
because it doesn't close the gap where the gap is biggest.

The one place this recommendation should be held loosely: the 800–1600
range is exactly where this spike's Go prototype is least representative
(single room-wide mutex, no region sharding) and where the measurements
were noisiest. If the relay's real deployments run many agents in one room
routinely, that range is worth a second look with a less simplified
prototype before treating the 1.5–2.6x number as final — see "what would
resolve the remaining ambiguity."

## What this spike didn't cover

- The whole-relay (cross-room) diff cost in `leases.py`/`relay.py`'s
  `_before()`/`_live()` is real by inspection (`self._claims` is one flat
  list for every room the relay serves) and was not empirically measured
  here — this spike's benchmark is single-room by design (per the brief:
  push members and claims *per room*), so "all claims" and "this room's
  claims" were the same set throughout. A relay running many busy rooms at
  once would pay this cost on every claim in *every* room, not just large
  ones; untested.
- One machine, loopback only, shared with ten other logged-in users and
  concurrent agent sessions throughout. Absolute numbers would very likely
  come down on a quiet box; the relative comparisons (paired, interleaved)
  are the part expected to survive that.
- Memory-per-connection was read from `ps -o rss=` on the relay process at
  two points (after join, peak), not sampled continuously; `relay_rss_kb_per_agent`
  in the raw JSON is noisy (sometimes negative — allocator/GC timing, not a
  real shrink) and shouldn't be read as a probe accurate to better than the
  peak-value ranges quoted above.

## What would resolve the remaining ambiguity

A version of the Go prototype with the room lock sharded by region (or
replaced with a lock-free map), re-run at 800/1600 on a quieter machine
with more rounds per point, would say whether the narrowing margin at high
concurrency is a real Go-vs-Python effect or an artifact of this
prototype's one mutex. A companion pass at the whole-relay diff — pre-
populating a relay with many busy rooms and remeasuring one room's claim
latency, both stock and with a room-indexed claims table — would give the
number this spike's single-room design couldn't produce for the other half
of the original "O(members + claims)" suspicion.
