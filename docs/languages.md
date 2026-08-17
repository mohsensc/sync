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
| `go/cmd/gorelay` + `go/internal/relaysrv` — the only relay now (#40) | Many-concurrent-connection network service under real load. `tests/load/scenarios.py` run against the Python relay before it was deleted: Go won p99 in 9 of 10 measured rows (5.9x at 200 agents), won `relay_cpu_ms_per_op` in every row without exception including the one p99 loss (that loss was client-bottlenecked, not relay-bound), lower post-drain RSS in every run, 5x the throughput and a fraction of the p99 against a deaf subscriber. The four things that blocked making it the only relay are closed: TLS termination (`crypto/tls`, same flag/env names as the Python side had), issue #47 (a background sweep now broadcasts an idle shard's expiry instead of waiting for that shard's next touch), issue #48 (`FindRoster` resolves symlinks, matching `Path.resolve()`), and the org policy floor + rung 4 (`policy.go`, `similarity.go`, ported from `policy.py`/`similarity.py`, rung 4 as-is per #15's own scope). `python/tests/` — the oracle that proved it correct — is deleted along with the Python relay; the black-box subset that ran over a real socket (`test_e2e.py`, `test_serve.py`, `test_relay_restart.py`) is checked in against the real `gorelay` binary (`python/tests/helpers/gorelay_proc.py`) and runs in `scripts/ci-local.sh`'s python job, and the `VirtualClock`-only suites that can't cross a process boundary (`test_backpressure.py`, `test_inbound_rate_limit.py`) are native Go tests now (`backpressure_test.go`, `inbound_rate_limit_test.go`) — the former caught a real bug in the port itself: `write()` blocked on a stuck send with nothing watching the clock, so a genuinely wedged peer was never shed. | `docs/relay-parity.md` |
| `go/cmd/agent-presence-mcp` | Install footprint only. `main.go`'s own doc comment says the process model is one-per-session, and `mcprelay/conn.go` says outright it mirrors Python's single-flight model with a mutex instead of an event loop — no concurrency claim is made or usable. No latency claim either: this process is spawned once and stays resident, so it never pays the ~2-2.5ms-per-exec Go tax the hook would. What's real: a from-scratch install with `python3` off `PATH` entirely still produced three working binaries. That's the whole case, and it's real, but it's one axis, and it rides `scripts/build-go-release.sh`'s cross-compile pipeline that already existed for `presenced` rather than needing its own. | `go/cmd/agent-presence-mcp` (`7e269ba`, "port the mcp server to go") |

**Correction to the record:** the previous version of this doc claimed the
MCP server port was unmerged, pointing at PR #46 and `python/src/agent_presence/mcp_server.py`
as the live implementation. Neither is true any more: the port landed
(`7e269ba`), `mcp_server.py` was deleted the same way (`cb103fe`), and
`go/cmd/agent-presence-mcp` builds and its tests pass. The row above
evaluates what's on this tree now, not a branch.

## C++

| Component | What dominates its cost | Evidence |
| --- | --- | --- |
| `cpp/hook/` (`ap-hook`) | Runs before every tool call, forked and exec'd fresh each time. `docs/gohook-spike.md` measured a real head-to-head against the real Go `presenced` (not a stale target): paired-delta puts Go's runtime-init tax at a consistent ~2-2.5ms over C++, idle or under storm. Under 16-lane storm — ordinary contention — 92-95% of Go's calls landed over the 5ms budget against 22-31% for C++. This is why the daemon moved to Go and the hook didn't: same measurement, opposite conclusion, because the two components pay different costs (per-exec startup vs. concurrent connection handling). | `docs/gohook-spike.md` |

## Python

| Component | What dominates its cost | Evidence |
| --- | --- | --- |
| `policy.py` (the compiler) | Fires on config file edits and CLI invocations, not tool calls or relay traffic — the relay's own floor resolution moved to Go (`relaysrv/policy.go`) along with the rest of the relay (#40). What's left in Python is `ap policy compile`/`explain`/`set`, which write the JSON blob `go/internal/policy` and the daemon read; no parsing happens on any decision path in either language. | `python/src/agent_presence/policy.py` doc comments |
| `policy_edit.py`, `cli.py` | Human-typed terminal surface, one invocation per command. No request loop, nothing where microseconds matter — `cli.py` is 1747 lines of argparse by design. | — |
| `principals.py` | The throughput-sensitive check (`Roster.authenticate`, one dict lookup + one `hmac.compare_digest`) is a Go-side concern now — `relaysrv/principals.go` carries its own copy for the relay's request path, roster-discovery symlink bug (#48) fixed to match. What's left in Python is TOML parsing and the CLI/token-minting surface, both human-invoked. | `go/internal/relaysrv/principals.go` |
| `priority.py` | 77 lines of O(1) dict lookups over a 4-entry table. The relay's own path uses the Go mirror now (`relaysrv/priority.go`); what's left in Python is `ap`'s display names. | `go/internal/relaysrv/priority.go` |
| `sim/simulation.py` | Deleted with the Python relay (#40) — depended on `leases.py`/`wait_die.py`, gone the same way. Its wait-for-cycle property is `go/internal/relaysrv/waitdie_test.go`'s table test now. | — |
| `tools/tune_rung4.py`, `similarity.py` | **Not deleted** — a previous version of this row (and of `STATUS.md`'s deletion list) claimed both went with the Python relay; they didn't, because they're not on the relay's request path to begin with, and never were. `similarity.go` is the relay's own lexical port (see the row above); `similarity.py` and `tune_rung4.py` are the offline corpus this repo tunes rung 4's threshold against (#15) and the tool that runs it, human-invoked, no relay involved. A Go rewrite of the corpus itself is still a candidate if that tuning work continues, but nothing here is stale in the meantime. | `python/tools/tune_rung4.py` |
| `tests/load/{scenarios,run,_lib}.py` (asyncio) | Still Python, still the harness this repo has — only one relay left to run it against now, so the "which client is the ceiling" question in the old text (multi-process Python client vs. a single asyncio one) is worth settling if `gorelay` gets pushed past where this harness's client bottlenecks first, same as before. Not re-investigated by this PR beyond confirming the harness still runs unmodified against `gorelay`. | `docs/relay-parity.md` |

## Boundaries confirmed correct as-is (not a language question)

- **hook<->daemon seam** (`cpp/hook/protocol.hpp` <-> `go/internal/hooksock`):
  best-documented seam in the repo, half-close-before-read specified
  identically on both sides. One stale line found: `protocol.hpp`'s header
  comment still claims "neither side needs to link the other," true when the
  C++ daemon `#include`d it directly, aspirational now that the daemon is Go
  and hand-mirrors the `Effect` enum instead. Doc fix, not a seam problem —
  fixed in this PR.
- **daemon<->relay seam** (`go/internal/wire` <-> `go/internal/relaysrv`):
  one implementation now (#40), so "swappable" is moot, but the seam is
  still guarded rather than assumed — `go/internal/relay/gorelay_integration_test.go`
  builds the real `gorelay` binary and runs the daemon's real (unmodified)
  relay client against it over a socket, in `go test`. What used to be a
  gap ("none of this cross-language verification runs in CI") is closed a
  different way for the relay's *wire protocol* specifically: the
  black-box suite (`python/tests/test_e2e.py`, `test_serve.py`,
  `test_relay_restart.py`, spawned against the real binary by
  `python/tests/helpers/gorelay_proc.py`) now runs in `scripts/ci-local.sh`'s
  python job, which needs a Go toolchain to build `gorelay` for it.
- **web<->relay seam**: two independent JS/TS clients of the same wire
  protocol (`web/src/main.ts` and `web/src/office/live.js`), not a language
  split — `live.js`'s own comment explains the duplication is forced by
  `office/*.js` running unbundled with no TS toolchain in that path, not a
  language choice. `live.js`'s `connect()`/`isPresence()` has run against a
  live `gorelay`; `main.ts`'s equivalent hasn't been run separately, only
  asserted equivalent by inspection. Worth closing, not worth a rewrite.

## The dual-relay problem (resolved)

This section used to lay out four things blocking `relay.py`'s deletion.
All four are closed, and the Python relay is gone (#40):

1. **A permanent, enforced black-box suite** — checked in as
   `python/tests/helpers/gorelay_proc.py` plus the three test files that
   use it (`test_e2e.py`, `test_serve.py`, `test_relay_restart.py`), 17/17
   passing against the real `gorelay` binary, running in
   `scripts/ci-local.sh`'s python job (which builds Go's `cmd/gorelay`
   before `pytest`).
2. **Native Go tests for what can't cross a process boundary** —
   `test_backpressure.py`'s and `test_inbound_rate_limit.py`'s
   `VirtualClock`-only cases are `backpressure_test.go` and
   `inbound_rate_limit_test.go` now. Porting the former surfaced a real
   bug the Python design comment (copied into `server.go`'s own doc
   comment) claimed but the Go code didn't actually have: `write()` sent
   over the raw socket and waited on it directly, with nothing watching
   the clock while it was in flight, so a peer whose write genuinely never
   returns was never shed and its writer goroutine leaked for the life of
   the process. Fixed by racing the send against a real-time poll ticker
   that decides on the injectable clock, matching what `serve.py`'s
   `_write` actually did.
3. **Org policy floor and rung 4** — ported. `go/internal/relaysrv/policy.go`
   is `policy.py`'s relay-facing slice (builtin + one org layer, exactly
   `policy.py`'s own `RELAY_INCLUDE` — the repo/user/session layers were
   never the relay's to resolve). `similarity.go` is `similarity.py`
   ported as-is, off by default, advisory — improving the scorer is #15,
   explicitly out of scope here.
4. **A replacement for the golden scenario's differential-oracle role** —
   none needed: `golden_test.go` now diffs against nothing but itself
   (there's no second implementation left to diff against), which is a
   smaller guarantee than before. What replaces it for anything that
   *would* have shown up as a diff is the black-box suite plus the
   negotiation/policy/rung4 test files this same PR added
   (`negotiation_test.go`, `policy_test.go`, `relay_policy_test.go`,
   `rung4_test.go`), which exercise the exact frame shapes and fields the
   golden diff used to catch drift in.

Issues #47 (expiry-broadcast latency: the Go relay's shard-scoped sweep
now also runs on a background ticker, so an idle shard's expiry doesn't
wait for that shard's next touch) and #48 (roster discovery: `FindRoster`
resolves symlinks now, matching `Path.resolve()`) are both closed, each
with its own test (`TestSweepAllBroadcastsAnIdleShardsExpiry`,
`TestFindRosterResolvesSymlinks`).

## Anything genuinely in the wrong language

Nothing. Every component checked against the record either has a measured
result backing its current language, or — for the one genuinely open
question left (the load harness's client-side ceiling, still Python, still
untested at 1600+ agents with a multi-process client) — the honest answer
is "undetermined, here's the measurement that would settle it," not "move
it." Rung 4's scorer (`similarity.go` now, ported from `similarity.py`
as-is) was the other open one; it moved with the rest of the relay (#40)
rather than staying behind, so there's nothing left to weigh there —
whether *improving* it is worth doing is #15, a product question, not a
language one. A clean bill on the language question, distinct from the
process/test gaps named above.
