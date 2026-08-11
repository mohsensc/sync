# Language boundaries: what owns what, and why

The rule: language follows what dominates a component's cost, decided by
measurement, not by which language is nicer or how much a port would cost.
Concurrency and connection-holding go to Go. Per-exec startup latency stays
C++. Config logic, offline tooling, and the embeddings-adjacent ladder work
stay Python. Python is kept where it's kept on purpose — this is not a march
to one language, and several components below were checked and left alone.

Evidence lives in `docs/gohook-spike.md` (hook, per-exec latency) and
`docs/relay-parity.md` (relay, concurrency/throughput/CPU/memory under load).
This doc points at both rather than restating their numbers.

## Go

| Component | What dominates its cost | Evidence |
| --- | --- | --- |
| `go/cmd/presenced` + daemon internals | Long-lived process, one goroutine per accepted connection on both the event and `.decide` unix sockets, plus the websocket pump to the relay. The old C++ daemon shared one accept queue and documented a 60% loss rate under storm from head-of-line blocking; the journal's single-goroutine-over-a-channel design structurally removes the C++ splice-tail deadlock class (issue #20). Concurrency correctness, not a raw-speed number — no head-to-head daemon benchmark exists against the deleted C++ daemon, because `cpp/daemon/` was deleted before one could be pulled. That's a real gap in the evidence, named here rather than papered over; it doesn't flip the verdict because concurrency correctness is its own admissible axis. | `docs/go-daemon.md`, `cpp/daemon/decision_server.hpp` (git history), `go/internal/journal` |
| `go/internal/decide` | Runs synchronously inside `presenced`, inside the sub-millisecond-to-2ms slice of the hook's 5ms budget. Not independently evaluated — it can't be extracted without changing the daemon's architecture, and doing so would add an IPC hop on the one path in this repo proven latency-sensitive. | `docs/gohook-spike.md` |
| `go/internal/policy` | A five-value enum lookup behind one mutex on the daemon's decision path. Deliberately not the policy engine — its own doc comment says TOML/globs/layers/precedence stay on the Python side; this only reads the one line of JSON `ap policy compile` writes. This is the fine-grained version of the rule in this doc: complex logic off the hot path, in Python. | `python/src/agent_presence/policy.py` (`compile_runtime`, `write_runtime_cache`) |
| `go/cmd/gorelay` + `go/internal/relaysrv` (opt-in, `AGENT_PRESENCE_RELAY_IMPL=go`) | Many-concurrent-connection network service under real load. `tests/load/scenarios.py` run unmodified against both relays, same machine, interleaved: Go wins p99 in 9 of 10 measured rows (5.9x at 200 agents), wins `relay_cpu_ms_per_op` in every row without exception including the one p99 loss (that loss is client-bottlenecked, not relay-bound — the CPU number proves it), lower post-drain RSS in every run, 5x the throughput and a fraction of the p99 against a deaf subscriber. Not yet the default: two features aren't ported (org policy floor, rung 4 — see "the dual-relay problem" below). | `docs/relay-parity.md` |
| `go/cmd/agent-presence-mcp` (**unmerged** — see correction below) | Install footprint only. `main.go`'s own doc comment says the process model is one-per-session, and `mcprelay/conn.go` says outright it mirrors Python's single-flight model with a mutex instead of an event loop — no concurrency claim is made or usable. No latency claim either: this process is spawned once and stays resident, so it never pays the ~2-2.5ms-per-exec Go tax the hook would. What's real: a from-scratch install with `python3` off `PATH` entirely still produced three working binaries. That's the whole case, and it's real, but it's one axis, and it rides `scripts/build-go-release.sh`'s cross-compile pipeline that already existed for `presenced` rather than needing its own. | PR #46 (`feat/go-mcp`, commit `dabc856`) |

**Correction to the record:** the MCP server port is not merged. `origin/main`
(`4b2fa68`) still ships `python/src/agent_presence/mcp_server.py`;
`go/cmd/agent-presence-mcp` does not exist on this tree. The port exists on
`feat/go-mcp` (PR #46), which carries roughly a dozen other unmerged commits
on top of it, so it isn't a simple fast-forward. Anyone planning around "MCP
is Go now" should check PR #46's status first — the paragraph above evaluates
the code that actually exists on that branch, not a claim about `main`.

## C++

| Component | What dominates its cost | Evidence |
| --- | --- | --- |
| `cpp/hook/` (`ap-hook`) | Runs before every tool call, forked and exec'd fresh each time. `docs/gohook-spike.md` measured a real head-to-head against the real Go `presenced` (not a stale target): paired-delta puts Go's runtime-init tax at a consistent ~2-2.5ms over C++, idle or under storm. Under 16-lane storm — ordinary contention — 92-95% of Go's calls landed over the 5ms budget against 22-31% for C++. This is why the daemon moved to Go and the hook didn't: same measurement, opposite conclusion, because the two components pay different costs (per-exec startup vs. concurrent connection handling). | `docs/gohook-spike.md` |

## Python

| Component | What dominates its cost | Evidence |
| --- | --- | --- |
| `policy.py` (the compiler) | Fires on config file edits, not tool calls. No parsing happens on any decision path — `go/internal/policy` and the daemon read only the pre-resolved JSON blob this writes. The one live-request use (`PolicyFile.current().resolve()` in the Python relay) gates its file stat to once a second, parsed `Policy` cached between checks. | `python/src/agent_presence/policy.py` doc comments |
| `policy_edit.py`, `cli.py` | Human-typed terminal surface, one invocation per command. No request loop, nothing where microseconds matter — `cli.py` is 1747 lines of argparse by design. | — |
| `principals.py` | The throughput-sensitive check (`Roster.authenticate`, one dict lookup + one `hmac.compare_digest`) runs once per connection join and is cached for the connection's daemon-scoped lifetime — far below the 5ms hook budget. The Go relay already carries its own copy of this check (`relaysrv/principals.go`) for its own request path; what's left in Python is TOML parsing and the CLI/token-minting surface, both human-invoked. See the dual-relay section for a real bug found in the Go copy's roster *discovery* (not the auth check itself). | `python/src/agent_presence/relay.py` (`_latch_grant`) |
| `priority.py` | 77 lines of O(1) dict lookups over a 4-entry table. Called per outgoing message, but dwarfed by the `json.dumps` and websocket send in the same call. Also already mirrored in Go for the Go relay's path. | `go/internal/relaysrv/priority.go` |
| `similarity.py` (rung 4) | Conditional verdict, not settled, but one open question closed: `redundant_peer`'s peer loop used to retokenize the incoming intent on every iteration even though it never changes across the loop. `LexicalSimilarity`'s tokenizer is now cached (`_tokens_cached`, an `lru_cache` over the pure tokenize function), which fixed exactly that - `python/tools/bench_redundant_peer.py` (checked in, replaces the ad hoc estimate this row used to cite) measures cold-cache, fresh-intent-per-call cost at 0.025ms/0.19ms/0.46ms for 5/50/200 peers, down from 0.024ms/0.32ms/1.05ms - roughly flat at 5 peers, ~1.6x at 50, ~2.3x at 200; the saving scales with room size because it removes (N-1) redundant tokenizations, not a fixed cost. `AGENT_PRESENCE_RUNG4` still defaults off (`ladder.py`'s `rung4_enabled()`), so this costs nothing today, which is still why the Go relay hasn't ported this. **If rung 4 ships enabled, this is a real Go candidate under storm; if it stays off, there is nothing to move.** Settling measurement: rerun the swarm scenario with `AGENT_PRESENCE_RUNG4=1` at 200 agents and read `relay_cpu_ms_per_op` — not yet done on either relay. |  `python/src/agent_presence/ladder.py`, `similarity.py`, `python/tools/bench_redundant_peer.py` |
| `sim/simulation.py` | Virtual-clock simulation, three unit-test assertions, sub-second runtime. CI-latency-tolerant correctness tooling, not a fuzzer. | — |
| `tools/tune_rung4.py` | Dev tool, run by hand, prints a table over a small hand-written corpus. No loop, no rate requirement. | — |
| `tests/load/{scenarios,run,_lib,_relay_boot}.py` (asyncio) | Unresolved, not "Python is wrong." This harness produced every Go-vs-Python number in `relay-parity.md`, so its own ceiling matters: at 1600 agents one Go-relay round showed `relay_cpu_s` of 4.88s against 23.41s wall-clock — the relay was busy about a fifth of the run, meaning the single-process asyncio *client* was closer to the bottleneck than the relay in that round. Whether the fix is a language rewrite or sharding the existing client across OS processes (an approach used elsewhere, not by this harness) is untested. Settling measurement: rerun at 1600+ agents with a multi-process Python client and check whether `relay_cpu_s` tracks wall-clock ~1:1 — if it does, the ceiling was architecture, not language, and Python stays. |  `docs/relay-parity.md` |
| `python/tests/` (~12,700 lines) | The parity oracle that proved the Go relay correct. Its fate is tied to the dual-relay question below, not a language question on its own — most of it drives the Python `Relay` object in-process and structurally can't run against an external process regardless of language. | see below |

## Boundaries confirmed correct as-is (not a language question)

- **hook<->daemon seam** (`cpp/hook/protocol.hpp` <-> `go/internal/hooksock`):
  best-documented seam in the repo, half-close-before-read specified
  identically on both sides. One stale line found: `protocol.hpp`'s header
  comment still claims "neither side needs to link the other," true when the
  C++ daemon `#include`d it directly, aspirational now that the daemon is Go
  and hand-mirrors the `Effect` enum instead. Doc fix, not a seam problem —
  fixed in this PR.
- **daemon<->relay seam** (`go/internal/wire` <-> `relay.py`/`serve.py`, both
  spoken by both relay implementations): the one seam in the repo actually
  proven swappable — `AGENT_PRESENCE_RELAY_IMPL=go` swaps the implementation
  behind one wire contract, backed by a zero-diff golden scenario and 13/14
  black-box tests. The gap is process, not design: none of this cross-language
  verification runs in CI. `.github/workflows/ci.yml` runs four fully
  isolated per-language jobs (python/cpp/go/web) and nothing builds hook +
  daemon + a relay together. A seam proven once by hand and unguarded after
  is a seam that can drift on the next change to either side.
- **web<->relay seam**: two independent JS/TS clients of the same wire
  protocol (`web/src/main.ts` and `web/src/office/live.js`), not a language
  split — `live.js`'s own comment explains the duplication is forced by
  `office/*.js` running unbundled with no TS toolchain in that path, not a
  language choice. `live.js`'s `connect()`/`isPresence()` has run against a
  live `gorelay`; `main.ts`'s equivalent hasn't been run separately, only
  asserted equivalent by inspection. Worth closing, not worth a rewrite.

## The dual-relay problem

The Python relay is still the default. Before it can be deleted, whatever
replaces `python/tests/` as the correctness oracle has to exist first —
that suite (and the golden-scenario diff it backs) is what proved the Go
relay right in the first place, and most of it can't be pointed at an
external process by construction (it drives the Python `Relay` object
in-process with a hand-advanced `VirtualClock`).

Concretely, before `relay.py` can go:

1. **A permanent, CI-enforced black-box suite**, not a one-off manual run.
   The subprocess-swap harness that produced the 13/14 result this wave
   lived in a scratch dir and doesn't exist in the repo today.
2. **Native Go tests for what can't cross a process boundary** —
   `test_backpressure.py`, `test_inbound_rate_limit.py`, and the
   internals-poking half of `test_relay_restart.py` are `VirtualClock`-driven
   and were only approximated by a real-time load scenario against Go, which
   is evidence of similar behavior, not proof of the same thresholds.
3. **Org policy floor and rung 4, ported or explicitly retired as a product
   decision** — not a language decision. `python/tests/` is the only test of
   the only implementation for both today; deleting `relay.py` deletes the
   features, not just a language.
4. **A replacement for the golden scenario's role as a live differential
   oracle.** It caught the region-parsing bug this port shipped with,
   specifically because it diffs against Python's *current* behavior; a
   frozen fixture rotted before and missed real changes. Nothing in the repo
   plays this role once there's no second implementation to diff against.

**Two real divergences surfaced while checking the auditors' work, both
verified against the code, neither caught by any existing test:**

- **Expiry-broadcast latency differs.** Python's `_live()` sweeps every
  claim in the process on every call and publishes any expiry it finds,
  anywhere. The Go relay shards claims 16-wide by path hash and only sweeps
  the shard a call touches — an idle shard's expiry can sit unbroadcast
  until something touches that region again or a member joins. Doesn't
  break arbitration (the daemon's own lease cache self-expires locally
  regardless), but it's a real staleness-bound difference in what other
  room members see, invisible to the two-agent golden scenario. Filed as
  [#47](https://github.com/mohsensc/sync/issues/47).
- **Roster discovery resolves symlinks in Python, not in Go.** `find_roster`
  calls `Path.resolve()`; `FindRoster` calls `filepath.Abs`, which doesn't
  touch the filesystem. Confirmed empirically on this machine, where
  `/tmp` -> `/private/tmp`: the two functions walk different directory
  chains from the same starting path. `Grant.priority()` feeds straight
  into wait-die's ordering, so a checkout reached through any symlink can
  get a different principal tier depending which relay is running, with no
  error either way. Filed as
  [#48](https://github.com/mohsensc/sync/issues/48).

## Anything genuinely in the wrong language

Nothing. Every component checked against the record either has a measured
result backing its current language, or — for the two genuinely open ones
(`similarity.py` under rung 4, the load harness's client-side ceiling) — the
honest answer is "undetermined, here's the measurement that would settle
it," not "move it." A clean bill on the language question, distinct from the
process/test gaps named above.
