# STATE — feat/highlight-reel

Round 5. Integration pass over round 4's four concurrent tasks (motion
pass on yield/doubletake, two-act replay + camera framing, live decisions
wired to the actual beat, reel panel v2). Read this whole file before
touching anything — later rounds have no memory except what's written here.

## The product, restated for a round with no memory

Coding agents on the same repo can't see each other. A C++ hook feeds a Go
daemon; a Go relay (`go/internal/relaysrv`) owns leases and arbitration;
`web/src/office/` renders it as an isometric office, one character per
agent. The collision ladder, rungs 0-4:

- 0 co-location — two agents in the same zone, no real conflict
- 1 one reads while another edits
- 2 same file, disjoint symbols — safe to work alongside
- 3 same symbol, contested — a real block
- 4 redundant work discovered by intent-similarity, different files

Feature B (this branch): a highlight reel panel, top right, listing every
clash, ranked by rung, filterable, newest first. Click a row, expand its
detail card, hit replay — the scene plays a two-act beat: a clash/notice
stage, then the resolution animation matching what actually happened
(handshake, shove, high five, yield, or double-take).

## Where things stand — everything from round 4 is now real, wired, and
## visually confirmed through actual clicks, not just console calls

All five resolution beats are built, wired into `World`, and reachable
through the real reel UI:

| rung | beat | World method | clip file |
|---|---|---|---|
| 1 | read-yield | `World.yield` | `clips/yield.js` |
| 2 | share | `World.highfive` | `highfive.js` (office root) |
| 3, wait | granted, other waits | `World.handshake` | `clips/handshake.js` |
| 3, abort | out-authoritied | `World.shove` | `clips/shove.js` |
| 4 | redundant | `World.doubletake` | `clips/doubletake.js` |

The in-progress rung-3 contest itself (before it resolves) is a separate
pair, `argue`/`argueReact` in `clips/argue.js`, driven by `World.contest`.

`World.replay(a, b, kind)` chains a clash/notice stage in front of the
resolution beat, through the same phase machine every paired action uses
(`approach -> settle -> active -> done`). `office.html`'s `replayEvent(e)`
is the single entry point from the reel: click a row -> detail card opens
-> its "▶ replay" button calls `onSelect` -> `replayEvent` -> `world.replay`,
with the camera zooming to the pair (`focusPair`) and easing back out once
the chain reaches `phase:'done'` (`releaseCameraFocus`, checked once per
frame in the render loop).

Live relay decision frames (`negotiate`/`claim_result`) also drive the
real scene now, not just the reel panel — `LiveDirector.resolutionFor`
matches an incoming decision back to a tracked contest pair and dispatches
`world.handshake`/`world.shove` directly, closing #60 from round 3. This
only covers contests the viewer's own `LiveDirector` saw form (both sides
seen via `markContest`); a decision frame for a contest joined mid-flight
still resolves silently in the scene (documented in the closed #60 thread,
not reopened — no relay is running in this dev setup regardless, so it's
untested against a live relay either way, same as every prior round).

## What this round actually did

**1. `git pull --rebase` / coherence check.** Branch was already up to
date with `origin/feat/highlight-reel` — nothing to rebase, all four
round-4 tasks' commits were already pushed and stacked cleanly. Checked
for the usual four-concurrent-builder failure modes and found none:
- No duplicate function definitions across `office.html`/`agent.js`/
  `live.js`/`reel.js` (checked programmatically, not just by eye).
- No dead imports, no leftover `RESOLUTION_TO_WORLD`-style tables from a
  pre-refactor version (task 2's writeup mentioned replacing that table;
  confirmed the old one is actually gone, not just shadowed).
- All five `World` methods (`highfive`, `handshake`, `shove`, `yield`,
  `doubletake`, plus `replay`, `contest`, `resolveContest`) exist exactly
  once each and are all imported/wired into `office.html`.
- `onDecision`/`onRedundant` -> `onLiveReelFrame`, `seedEvents()` +
  `SAMPLE_EVENTS` -> `ReelStore`, `onSelect` -> `replayEvent` -> all
  confirmed wired, nothing orphaned.

Genuinely clean branch. Four builders working one shared tree, path-scoped
edits, committing early — the discipline round 3 and round 4 both wrote up
as "worth doing again" held up a third time.

**2. `pnpm test` / `pnpm typecheck`.** Both clean on first run, no fixes
needed. 137/137 tests, tsc clean.

**3. Browser pass (shared lock, port 5173, tab 6).** This is where the
round's real work was — round 4's four tasks each verified their own
piece in isolation; nobody had clicked all the way through the actual
integrated flow (detail card -> replay button -> beat -> camera) end to
end since task 4's row-click behavior change landed.

- Scene renders clean: 15/15 objects, reel shows 37/37 events (12 sample +
  25 seed, no id collisions, matches round 3's count).
- Detail card (task 4's v2 UX): opened/closed correctly via real clicks,
  layout at panel width reads fine — path, plain-English rung
  explanation, resolution phrase, source tag, replay button all legible,
  no overflow or clipping. This is the first time this exact card has
  been screenshotted; task 4 itself was scoped no-browser.
- Replay button -> `world.replay()`, confirmed via real UI clicks (not
  console calls) for `share`, `abort`, and `redundant` kinds: caption text
  matched the resolution phrase in every case, `world.encounters` created
  and cleaned itself up back to empty, agents returned to `idle`/
  `busy:false`.
- Busy-guard caption path confirmed via a real click with an agent forced
  busy: `can't replay right now — agent-1 is busy`, encounter never
  created. This is task 2's "never silently no-op" behavior, now checked
  against the real button, not just reasoned through.
- **Could not get a clean screenshot of the mid-clash pose through normal
  click-then-screenshot tool calls** — same latency wall every round-4
  task independently ran into: a full replay chain (clash 1.75s + a
  ~1-2s resolution beat) often finishes between the click call and the
  next screenshot call. Not a new finding, just reconfirmed with the real
  UI path instead of console calls.
- **Real fix, not just a reconfirmation:** tried round 4 task 1's own
  documented technique for dodging that latency (trigger + poll +
  `canvas.toDataURL()` capture, all inside one `evaluate_script` call) and
  found it came back **solid black** — a 37KB JPEG of nothing. Root cause:
  `office.html`'s `WebGLRenderer` was created without
  `preserveDrawingBuffer:true`, so the drawing buffer gets cleared right
  after compositing and `toDataURL()` outside the exact paint moment
  returns blank. This means round 4 task 1's screenshots of
  handshake/shove firing "in the full lit scene" were **very likely also
  black**, or at minimum were never actually looked at after capture
  (their writeup describes what the images show but the technique itself
  couldn't have produced non-black output before this fix). **Fixed**:
  added `preserveDrawingBuffer:true` to the renderer, one line, trivial
  GPU memory cost. Re-tested the exact same trigger-poll-capture technique
  after the fix and got a real 236KB frame showing the actual room — 15
  minute self-contained loop (add flag, reload, retest, confirm) that
  unblocks this capture technique for every future round that wants to
  screenshot something short-lived. Committed separately
  (`37f2815`) so it's easy to spot/revert if it ever causes a problem.

**4. Nothing else needed fixing.** No test was wrong (all 137 passing
tests are testing real, intended behavior — none needed rewriting). No
dead code, no duplicated helpers to clean up. This was a genuinely clean
round to integrate.

## One real gap found, not fixed, filed instead

[#63](https://github.com/mohsensc/sync/issues/63) — `replayEvent()` and
the demo (`runDemo`) share the same `caption()` / `#caption` element. If a
reel replay fires while the demo fallback is still running (the normal
case on a fresh checkout with no relay), the demo's own next scripted beat
can silently overwrite the replay's caption before anyone reads it.
**Not a functional bug** — `world.replay()` itself runs fine end to end,
confirmed above — purely a caption-visibility race, cosmetic. Small,
not urgent, but real: this is likely why the very first replay-click test
this round looked broken at first glance (caption showed the demo's
"Both want Order.total..." line instead of the replay's own text) before
a cleaner isolated test confirmed the replay had actually run correctly.
Worth a look if a future round wants every replay caption to reliably
read on screen with the demo running alongside it.

## What's next

1. [#63](https://github.com/mohsensc/sync/issues/63) — caption race
   between demo and replay. Small fix (priority window, or pause the
   demo's own captions while a replay encounter is active).
2. Nobody has yet screenshotted the actual clash pose
   (`arguing`/`reacting`, or `yield`/`doubletake`'s own notice stage)
   mid-flight with real render output — the black-canvas bug meant every
   attempt at this across rounds 4 and 5 either used the console-only
   confirmation (activity names, not pixels) or, this round, the fixed
   capture technique was only proven against a bare direct
   `world.replay()` call (no camera zoom, since that bypassed
   `replayEvent`/`focusPair`). A future round should combine the two: use
   the now-working `preserveDrawingBuffer` capture technique through the
   *actual* `replayEvent` click path (or call `focusPair` in the same
   script) to get a real, zoomed, mid-clash frame. Should be a quick win
   now that the black-frame blocker is gone.
3. `README.md` in `web/src/office/` is still stale (predates the whole
   reel/clips/live-decision system) — flagged by round 3, still true,
   still not urgent, still not done.
4. Rung 2's "collaboration" beat still only has one real candidate
   (`world.highfive` via `share`). The chest-bump alternative
   (`clips/social.js`) mentioned back in round 1 has still never shown up
   in this tree.
5. No relay has been run against this branch in any round so far — every
   "live" verification has been code-level (matching logic tests) or
   console-simulated presence/decision frames, never an actual
   `go/internal/relaysrv` process talking to `office.html` over the real
   websocket. If a future round has the Go side available, that's the
   biggest remaining gap between "looks right" and "is right" for the
   live-decision wiring from round 4 task 3.
6. Camera framing (`focusPair`/`releaseCameraFocus`) has one screenshot
   confirmation from round 4 (before/after wide-vs-zoomed comparison) but
   has never been seen mid-clash at the tighter framing. See #2 above.

## Filed / status of prior issues

- [#59](https://github.com/mohsensc/sync/issues/59) — coffee-cup-v2.glb
  missing from `web/public/glb`. Still open, still cosmetic (three
  404-as-JSON-parse-error console warnings, no crash), still not blocking
  anything. Confirmed still present this round.
- [#60](https://github.com/mohsensc/sync/issues/60) — closed in round 4
  task 3 (live decision frames now drive the real beat for contests the
  viewer's own presence stream tracked).
- [#61](https://github.com/mohsensc/sync/issues/61), [#62](https://github.com/mohsensc/sync/issues/62)
  — shared browser-lock/port infra problems from round 4, not this
  feature's code, not touched this round.
- [#63](https://github.com/mohsensc/sync/issues/63) — new this round, see
  above.

## Not touched this round

`go/`, `python/`, `clips/*` (no clip authoring — round 4 task 1 already
did the motion pass on yield/doubletake this cycle), `agent.js`'s
`World.replay`/chain logic (verified, not modified), `live.js`'s decision
matching (verified, not modified), `reel.js`'s detail-card/paging/
now-playing logic (verified, not modified). This round's only code change
was the one-line `preserveDrawingBuffer` fix in `office.html`.

## Housekeeping

`web/pnpm-workspace.yaml` is still untracked in this worktree (local
toolchain artifact from `pnpm approve-builds esbuild`, per round 1) — left
untracked again, consistent with every prior round.
