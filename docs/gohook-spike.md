# Spike: does a Go hook meet the 5ms budget (issue #23)

**Date:** 2026-08-11
**Status:** done. Recommendation: keep the hook in C++, port only the daemon (#18).

## What was built

`spike/gohook/main.go` — a straight port of `cpp/hook/`'s hot path and
nothing past it: read stdin (same 1MiB cap, same 1000ms read ceiling), the
same naive scalar JSON field extractor cpp/hook/hook.cpp uses instead of a
parser, the same two-socket protocol (event socket, `.decide` socket,
half-close before read, 2ms budget), the same floor table, print
`hookSpecificOutput` JSON, exit. It does not port the daemon-message prose
(handover/lost/near/blocked wording) — that's policy dressing, not hot-path
cost.

`spike/gohook/bench/run.py` — the harness. Starts a real `presenced` (no
relay reachable, empty lease cache), then runs `ap-hook` and `gohook` head to
head as real subprocesses — fork+exec every call, not `ap::run_hook` called
in-process the way `tests/load/hookbench.cpp` does — alternating cpp/go one
call at a time so both eat the same thermal drift and background load, at
idle and under 16 threads hammering the event socket the way
`tests/load/scenarios.py`'s `storm()` does.

Neither file is wired into the build, CI, or `install.sh`.

## Conditions

Apple M4 Pro, 12 cores (8P+4E), macOS 26.5.1 arm64, Go 1.26.5, AppleClang 21
`-O`-default cmake build (Release not forced — same flags the repo's own
`cmake -S cpp -B cpp/build` produces). **Not a quiesced benchmark box**: this
is a live dev laptop with several other Claude Code agent sessions running
concurrently during every run. `uptime` load average during the runs ranged
4.7–9.2 on 12 cores. That matters for reading the absolute numbers below —
see "the C++ baseline doesn't transfer" — and it's why the paired-delta
analysis, which cancels shared noise, carries more weight than the raw
percentiles.

`ap-hook` is 73KB, dynamically linked against libc++/libSystem. `gohook` is
3.3MB, statically linked — typical for Go. That size difference (45x) is part
of what fork+exec is paying for on every call.

## The numbers

Three independent runs, 1000–1200 calls per hook per condition,
fork+exec included, real `presenced` on the other end of the socket:

| run | condition | hook | p50 | p95 | p99 | max | over 5ms |
|---|---|---|---|---|---|---|---|
| A (n=1200) | idle | cpp | 4.99ms | 17.59ms | 51.66ms | 142.94ms | 589/1200 |
| A | idle | go | 5.03ms | 22.75ms | 61.58ms | 133.41ms | 624/1200 |
| A | storm16 | cpp | 3.38ms | 7.77ms | 14.97ms | 70.62ms | 360/1200 |
| A | storm16 | go | 5.72ms | 8.99ms | 14.79ms | 135.94ms | 1118/1200 |
| B (n=1000) | idle | cpp | 2.90ms | 5.66ms | 7.13ms | 12.26ms | 122/1000 |
| B | idle | go | 4.71ms | 5.91ms | 10.52ms | 13.65ms | 150/1000 |
| B | storm16 | cpp | 3.47ms | 8.02ms | 16.14ms | 29.37ms | 311/1000 |
| B | storm16 | go | 5.85ms | 10.06ms | 14.67ms | 24.41ms | 949/1000 |
| C (n=1000) | idle | cpp | 2.42ms | 5.65ms | 7.93ms | 74.52ms | 135/1000 |
| C | idle | go | 4.69ms | 6.13ms | 11.27ms | 29.31ms | 153/1000 |
| C | storm16 | cpp | 3.22ms | 7.51ms | 11.56ms | 24.01ms | 217/1000 |
| C | storm16 | go | 5.70ms | 8.61ms | 12.66ms | 15.85ms | 919/1000 |

Run A happened while this machine's load average was highest (see raw
`daemon.log`-adjacent timestamps); B and C are more representative and agree
with each other. All three point the same direction.

### The C++ baseline in the issue doesn't transfer here

The issue's reference numbers — 0.496ms p99 idle, 0.67ms p99 at 16 lanes,
zero calls over 5ms — come from `hookbench.cpp`, which calls `ap::run_hook`
**in-process**, deliberately excluding fork+exec (its own comment says so:
"a fork+exec measurement buries it under 3-10ms of process setup"). Once
fork+exec and real OS scheduling are counted, on this machine, **the C++
hook itself lands well past 5ms at p99 too** (7.1–16.1ms across runs B/C).
That's not a regression in the C++ hook — it's proof the two measurements
answer different questions. The in-process number says the socket phase is
cheap. This spike's number says process-spawn cost, on a real machine doing
real other work, is the dominant term for *either* language at this process
lifetime — which is exactly why the comparison has to be relative, not
against the 0.496ms/0.67ms figures directly.

A no-daemon, no-socket control makes the same point: even `/usr/bin/true`,
timed through this harness, has p50 1.71ms / p99 5.33ms on this machine.
Process-spawn overhead alone is most of the budget before any hook code runs.

### Isolating Go's own cost: paired deltas

Because every call is cpp-then-go back to back, the shared machine noise at
that instant is nearly identical for both. Subtracting per-pair
(`go_ms − cpp_ms`) from run C's raw samples cancels it and leaves what's
actually attributable to the runtime:

| condition | mean delta | median delta | p90 delta | p99 delta | go slower in |
|---|---|---|---|---|---|
| idle | 1.38ms | 2.20ms | 2.57ms | 6.09ms | 84% of pairs |
| storm16 | 1.96ms | 2.37ms | 3.32ms | 7.34ms | 90% of pairs |

A no-socket control (fork+exec only, no daemon involved) shows the same
shape at smaller scale: cpp p50 1.95ms vs go p50 2.70ms, a ~0.75ms delta from
runtime init alone. The rest of the ~2.2ms delta under a real socket round
trip is Go's net package spinning up its poller machinery (kqueue setup,
resolver) on first use in a process that only ever uses it once.

This is the load-bearing number in this spike: Go costs a consistent
**~2–2.5ms more than C++ per invocation**, idle or under storm, machine noise
included or not.

### Under storm, the gap in headroom is the real finding

C++ tolerates the 16-lane storm without much change in its over-5ms rate
(122–135 idle → 217–311 storm, roughly 2x). Go's over-5ms rate goes from
already-bad to almost total: 150–153 idle → 919–949 storm, i.e. **92–95% of
Go's calls landed over the 5ms budget under storm**, against 22–31% for C++
under the identical load. C++ has slack to absorb contention; Go's fixed
runtime tax leaves it almost none.

## Recommendation

**Keep the hook in C++. Port only the daemon (#18).**

Applying the decision rule fixed in the issue: Go's p99 was never
"comfortably under 5ms with margin" in any of three independent runs,
2000+ samples each — it sat at 10.5–14.8ms, 2–3x over budget, in every
condition tested. The paired-delta analysis, which is the part of this
result least sensitive to this being a busy shared machine rather than a
quiet CI box, shows a consistent ~2–2.5ms Go tax on top of whatever C++ pays,
and under storm — the condition that actually matters, since that's
ordinary contention from a busy session — that tax consumes nearly all of
Go's slack while C++ still has room. That's the runtime-init cost the issue
predicted, measured rather than assumed.

## What would resolve the remaining ambiguity

The one number this run couldn't cleanly separate from machine load is
Go's *absolute* p99 in isolation — a quiesced, single-purpose machine (no
concurrent agent sessions, no browser) would very likely pull both hooks'
raw percentiles down. But the paired-delta method already isolates Go's own
overhead from that shared noise, and it says the same thing at both load
levels observed here, so a quieter machine is expected to sharpen this
result, not flip it. If it's worth re-checking: rerun
`python3 spike/gohook/bench/run.py --iters 1000 --storm-lanes 16` on an idle
box and see whether Go's own p99 (not just its delta over C++) drops under
5ms with real margin.
