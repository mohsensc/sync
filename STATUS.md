# Status

Written 2026-08-07. Every number here came from running the thing, not from reading it.

## Where the code is

`main` is the unwired state: no `relay_client.cpp`, no `decision_server.cpp`, no
console scripts, daemon and relay never touch. It's all in five open PRs.

## The stack

| PR | branch | base | what it is |
| --- | --- | --- | --- |
| 1 | feat/wire-transport | main | wires the chain: relay client, decision path, entrypoints |
| 2 | feat/rung-4 | feat/wire-transport | redundant work across different files |
| 3 | test/load-harness | feat/wire-transport | load and chaos harness, measures only |
| 4 | fix/lease-protection | feat/wire-transport | fixes most of what #3 found |
| 5 | chore/ci | feat/wire-transport | GitHub Actions |

2, 3, 4 and 5 all sit on the current tip of feat/wire-transport, so the bases are
fine. Two collisions:

- #4 vendored #3's `tests/load/` instead of branching off it, then edited `run.py`
  and `scenarios.py`. Merging #3 then #4 gives an add/add conflict on both files.
  Take #4's copy — it's the same harness with the assertions updated to match the
  fixes. #4 is a superset of #3.
- #4 and #5 both rewrite the test instructions in README.md. Content conflict.

Merge order: 1, 3, 4 (take #4's tests/load), 5 (resolve README), 2. #2 is clean
against all of them, so it can go anywhere after 1.

CI only exists once #5 lands, so PRs 1-4 have no checks on them. #5's own runs are
green on all three jobs.

## Suites, run today

| branch | pytest | ap_tests | web |
| --- | --- | --- | --- |
| feat/wire-transport | 459 passed in 10.02s | 2256 assertions / 141 cases | 23 vitest, tsc clean |
| feat/rung-4 | 524 passed in 9.92s | 2256 / 141 (unchanged) | unchanged |
| test/load-harness | 459 passed in 10.12s | unchanged | unchanged |
| fix/lease-protection | 470 passed in 18.01s | 2282 / 148 | unchanged |

`ctest --test-dir cpp/build` passes 1/1 now. It didn't before #1.

## End to end, clean checkout of fix/lease-protection

Fresh clone, cmake build, fresh venv. Real `agent-presence-relay` console script,
real `presenced`, real `ap-hook`. Second agent joins over websocket and claims
`/repo/src/auth.py` with intent "refactor sign_in to JWT". Then the hook fires for a
different agent on that path:

```
{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny",
"permissionDecisionReason":"sara is editing /repo/src/auth.py right now, in the same
region you are about to change: \"refactor sign_in to JWT\". This edit is blocked by
agent presence so the two of you do not overwrite each other. ..."}}
```

PASS. Control on a different path prints nothing and exits 0. Snapshot and statusline
work too: `{"peers":[{"human":"sess_demo","verb":"edit","path":"/repo/src/auth.py"}]}`
and `· sess_demo here`.

## Still broken, missing or unproven

- No real Claude Code session has ever driven this. Every e2e, including the one
  above, is scripted websocket clients and a hand-piped hook payload. The settings.json
  integration is untested against an actual session.
- Rung 4 ships off. `AGENT_PRESENCE_RUNG4` defaults to unset. The backend is a
  lexical token-overlap scorer with a hand-typed synonym table, not embeddings.
  Threshold 0.82 was tuned against 23 hand-written pairs — 6 of 8 duplicates caught,
  0 false positives, on the corpus it was tuned on. It also requires `source == "mcp"`,
  so it's only reachable through the claim path that doesn't go over the wire. Verified
  it fires end to end with the flag on, and it's advisory: the claim is still granted.
- #4 doesn't close the load harness out. 6 of 10 scenarios still fail, 9 findings.
  Down from 9 failing and 15 findings on #3, so it fixed cross-room lease loss, stale
  leases across a relay restart, unbounded memory on a slow subscriber, broken lease
  handover, refused event connections, and the 8% of decisions that were silently lost
  under a hook storm. Still open: wait-die never says wait (every refusal is an abort,
  so 50 agents on 5 regions get 8.5% of claims through), claim p99 34ms at 200 agents,
  snapshot write amplification at 19/s against a documented 1/s, and lease expiry is
  never broadcast so daemons block on leases the relay already dropped.
- `daemon-kill-under-load` is flaky on #4 — failed with a 25-26ms hook max, passed on
  the next run. #4 made it measure harder, so it's unclear whether that's a regression
  or something #3 was too short to catch.
- 3D assets don't exist. The dashboard is `BoxGeometry` floors and `CapsuleGeometry`
  people. No loader, no meshes.
- Relay hosting and persistence are unaddressed. In-process asyncio, state in dicts,
  no storage. Restart loses the lease table.
- The statusline shows session ids, not names. The daemon logs nothing, ever.

## Worktrees

`../sync-rung4`, `../sync-load`, `../sync-fixload`, `../sync-ci` are all clean, and
each is at the same commit as its origin branch. No unpushed commits, no stashes.
All four are safe to `git worktree remove`.
