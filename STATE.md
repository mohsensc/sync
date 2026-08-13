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

## Round 6 task 4 — replay presentation: caption arbiter, variant dispatch, versus card

Three connected pieces in the replay-presentation region of `office.html`,
plus two new standalone modules. No browser access this round (task
scoped BROWSER: no) — everything below is code-level/test-verified only;
see the flag at the end.

**(a) #63 fixed.** New `web/src/office/caption.js`: a pure priority
holder (`set(text, {priority})`, `hold(priority)` → token, `release
(token)`, `isHeld()`). Replay priority beats demo priority; while a replay
hold is active, demo writes are silently dropped rather than queued —
that's the whole fix, the race was purely "last write wins with no
concept of who currently owns the line." `office.html`'s `caption()` and
the caption handle passed to `runDemo` are the same function now, both
routed through the arbiter at demo priority. `replayEvent()` takes a hold
at replay priority the moment it starts a beat, stores the token in a new
module-level `replayCaptionToken`, and the render-loop's existing
`replayEnc.phase === 'done'` check (already there from round 4 task 2)
now also releases that hold and hides the versus card. Unit tested in
`web/test/office-caption.test.ts` (5 cases: plain write-through, hold
blocks lower priority, same-priority write while held still lands, a
stale token can't release a newer hold, `isHeld()` state). Closed
[#63](https://github.com/mohsensc/sync/issues/63) with a comment pointing
at the fix and the test file.

**(b) Variant dispatch in `replayEvent()`.** `share` resolutions now pick
among `world.highfive` / `world.chestbump` / `world.fistbump`; `abort`
among `world.shove` / `world.waveoff` / `world.slap`. Every non-base name
is gated on `typeof world[name] === 'function'` — this tree may or may not
have tasks 1/2's clips landed depending on merge order, and the dispatch
falls all the way back to the existing `world.replay(a, b, kind)` two-act
chain (clash then resolution) when a variant name doesn't exist, so
nothing regresses if those land after this or not at all. Selection order:
`?beat=<name>` forces one (only if it names a real function); otherwise a
small FNV-ish hash of `event.id` + how many times that exact event has
been replayed this session picks deterministically, so clicking replay
twice on the same row shows a different take but a fresh page load always
shows the same first take for a given id.

One subtlety worth flagging for whoever touches this next: a **non-base**
variant call bypasses `world.replay()`'s two-stage chain entirely and
calls the standalone `World` method directly (`world.chestbump(a,b)`,
`world.waveoff(b,a)`, etc.) — those are already complete self-contained
beats (own approach + contact), same shape as `world.highfive`/
`world.shove` today, so this was the honest way to reach them without
reaching into `agent.js`'s `REPLAY_CHAINS` (owned by tasks 1/2 this round,
append-only). The cost: picking a non-base variant means the replay skips
the leading "clash" stage (the arguing/reacting standoff) and goes
straight to the alternate resolution beat — so `?beat=waveoff` looks like
"they just resolve it," not "they argue, then one waves the other off."
Filed nothing for this — it's a known, cheap-to-explain tradeoff, not a
bug, and fixing it properly means teaching `agent.js`'s chain builder
about variants, which is out of this task's file ownership. Worth a look
if a future round wants every variant to keep the clash lead-in.

Also: the `abort` family's direct-call branch swaps argument order
(`world[variant](b, a)`) because the reel's own convention through this
whole function is `a` = stands down, `b` = prevails, while `shove()`'s
(and by the same fixed contract, `waveoff()`/`slap()`'s) standalone
convention is `(winner, loser)`. Easy to get backwards; flagging in case
it trips someone up reading the diff.

**(c) Versus card.** New `web/src/office/replay-card.js`:
`createReplayCard(container, variant)` where `variant` is `'split'`,
`'strip'`, or falsy (falsy returns a no-op `{show(){}, hide(){}}` — the
feature is off by default, plain caption is still what plays unless
`?vcard=split|strip` is on the URL, so a normal checkout is unchanged).
`split` renders a lower-third that slides two named-party halves in from
the left/right edges with a rung badge and verdict line in the middle;
`strip` is one dense single line with an inline badge. Rung colors are a
five-entry copy of `reel.js`'s `RUNG_INFO` hex pairs (deliberately not
imported — same small-copy-across-the-boundary pattern `office.html`
already uses for `RESOLUTION_LABEL`, live.js's `HAIR`, zones.js's
`PALETTE`). Wired into `office.html`: a `#replayCard` div next to
`#caption`, CSS appended right beside `#caption`'s own block (not
touching the reel CSS block, which is task 3's), `replayEvent()` calls
`replayCard.show({a, b, rung, label})` alongside the caption hold, the
render-loop `done` check calls `replayCard.hide()`.

**Files added:** `web/src/office/caption.js`, `caption.d.ts`,
`replay-card.js`, `replay-card.d.ts`, `web/test/office-caption.test.ts`.
**Files touched (append/edit within owned regions only):** `office.html`
— imports, `#caption`/new-card CSS, the `#replayCard` div, `caption()`,
the `runDemo` caption wiring (already flowed through `caption()`, no
separate change needed there), `replayEvent()` and its
`RESOLUTION_LABEL`/variant-dispatch neighborhood, the render-loop `done`
check.

Note on how this landed in git: this worktree is shared live across all
four of this round's tasks (one working tree, not one per task), so by
the time this task's `office.html` edits were ready to commit, task 3 had
already run `git add`/`git commit` over the same file and picked up this
task's in-progress edits along with its own (commit `19fa985`, "add glass
and ticker reel skins, cycle button" — that commit's diff includes both
the reel-skin work and this task's caption/dispatch/card wiring in
`office.html`, even though the message only names the former). Confirmed
by inspecting that commit's diff before pushing further work: no
duplication, no missing pieces, both features intact side by side. Only
the new standalone files above landed in this task's own commit
(`ece6cb4`, "add caption arbiter and versus-card module (#63)") since
those were untracked and task 3's `git add` didn't reach them. Flagging
so nobody reads the commit graph and assumes task 4's `office.html` work
is missing — it isn't, it's just filed under someone else's commit
message.

**Verified:** `pnpm test` (144 passed, up from 137 at round start — 7 new:
5 caption-arbiter cases plus 2 from task 3's `office-reel-skin.test.ts`)
and `pnpm typecheck` both clean. Dispatch fallback logic (base-variant
selection, `typeof` guards) reasoned through by hand against the current
`agent.js` — `world.highfive`/`world.shove` both exist, so the base path
is exercised correctly regardless of whether tasks 1/2 landed their new
clips in this tree yet.

**Not verified — flagging for the next round/integrator:** everything
under (c), and the non-base branch of (b), is browser-unverified. Nobody
has looked at the versus card render in an actual page load, in either
variant, nor confirmed the slide-in animation reads as intended, nor
clicked a reel row with `?beat=chestbump` (etc.) once tasks 1/2's clips
exist to confirm the direct-dispatch path actually plays a visible beat
end-to-end (only the fallback path — `world.replay()` — has multi-round
history of being seen working). First stop for whoever has the browser
lock next: load `office.html?vcard=split` and `?vcard=strip`, click a
rung-2 and a rung-3 reel row a few times each to see the beat cycle, and
check contrast of the split card's white-on-navy text against the actual
3D scene behind it (same class of check task 3 did for the glass reel
skin).
