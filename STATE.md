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

## Round 6 task 3 — reel panel skins (browser: no, per the task spec)

Built the two alternative looks the brief asked for, plus the switching
mechanism, plus a standalone harness. `reel.js` was this task's only
touched-everywhere file; `office.html` was scoped to its CSS block and the
`mountReel` call site, as the plan required.

**What changed and why:**

- `RUNG_INFO` (the old color/bg lookup baked into `reel.js` and written as
  an inline `style=` attribute on each badge) is gone. Badges now carry
  `data-rung="N"` and every color lives in CSS, keyed off
  `.reel-badge[data-rung="N"]` — plain (paper) as the unscoped base case,
  `.reel-skin-glass .reel-badge[...]` / `.reel-skin-ticker .reel-badge[...]`
  as overrides. This was the only way to let a skin repaint the one
  "saturated color" element the glass brief calls for without `!important`
  fighting an inline style. Task 4's `replay-card.js` independently copied
  the same five hex pairs into its own `RUNG_COLORS` (their file's own
  comment says so) rather than import from here — unaffected by this
  removal, confirmed by reading their file before touching mine.
- `mountReel(container, store, opts)` gained `opts.skin` (validated through
  the new pure `resolveSkin(value)` export, unrecognized/missing always
  falls back to `'paper'`) and draws a small cycle button in the head
  (`paper -> glass -> ticker -> paper`). Skin state is a class on
  `container` (`reel-skin-<name>`), applied by `mountReel` itself — no
  markup changes needed in `office.html`, since the div it mounts into
  already exists and I'm not allowed to touch that line this round anyway.
  Added `getSkin()`/`setSkin()` to the returned handle too, for anything
  that wants to force a look without clicking (the harness doesn't end up
  needing them — set at mount time instead — but it seemed like the
  obvious API to also expose alongside a button that already does it).
- `office.html`: `?skin=glass|ticker` read once at mount time via
  `resolveSkin(new URLSearchParams(location.search).get('skin'))`, passed
  straight into `mountReel`'s `opts.skin`. No default query means `'paper'`
  — a fresh link with no `?skin` looks exactly like it always has.
- `office.html`'s reel CSS block grew a `.reel-skin-glass` and a
  `.reel-skin-ticker` section, both scoped entirely by class selectors so
  they'd work identically if reused on a container with a different id
  (which is exactly what the harness does).
- `reel.d.ts` updated to match: `ReelSkin`, `SKINS`, `resolveSkin`, the new
  `MountReelOptions.skin` and `MountedReel.getSkin`/`setSkin`.
- New `web/test/office-reel-skin.test.ts` — the one bit of pure logic this
  task extracted (`resolveSkin`) gets a small describe/it block, per the
  task's own "add a small test only if you extract pure logic" clause.
  `ReelStore` itself: untouched, still skin-ignorant, `office-reel.test.ts`
  passes with no edits.

**The three looks:**

- `paper` (default) — unchanged, the original warm cream card. Needed no
  new CSS of its own; everything above the "reel skins" section already is
  the paper look.
- `glass` — `rgba(20,26,36,.78)` + `backdrop-filter: blur(16px)
  saturate(150%)`, light text at varying opacity (full white for the
  primary "who" line, down to ~30% for dividers), rung badges the only
  saturated color on the panel (brightened versions of the same five hues
  so they read against a dark ground instead of the light `EEF0F3`-family
  backgrounds paper uses).
- `ticker` — flat `#0A0E13`, hairline border, no shadow, no rounded card
  feel beyond a 4px radius. Rows collapse to one line via `display:contents`
  on the existing `.reel-line1`/`.reel-line2` wrapper spans — same markup
  as the other two skins, CSS just unwraps them into the row's flex
  container so R-badge/who/path/resolution/time sit on one baseline.
  Source tags (`live`/`generated`) are hidden here on purpose — the detail
  card still shows source, and a five-piece single line was already
  crowded without a sixth chip.

**Harness:** `web/src/office/reel-skins-test.html` — three independent
`mountReel` instances, three independent `ReelStore`s (each needs its own
open/filter state, so one shared store across three DOM mounts would have
had them all show the same open row), fed the same
`[...SAMPLE_EVENTS, ...seedEvents()]` array. Left panel is `paper` with a
detail card pre-opened (`store.toggleOpen(events[0].id)` before mount).
Middle is `glass`, plain list, over a radial-gradient background standing
in for the 3D scene (blur needs something to blur). Right is `ticker`,
pre-filtered to a human that matches nobody (`setHumanFilter('nobody-
here')`) to show the empty state. All three panels' own cycle buttons still
work, so this is also how the next round can check any skin against any of
the three states without visiting all nine combinations by hand.

**Not verified in a browser** — this task was scoped browser:no. The CSS
is written and reasoned about (contrast ratios estimated, not measured
with a tool) but nobody has loaded `reel-skins-test.html` in an actual
tab. This is flagged as this round's plan required: **the harness is
unverified and should be the next integrator's first stop** — specifically
check (1) the glass blur actually reads as glass and not just a dark box
in whatever browser renders it, (2) the ticker's `display:contents` trick
doesn't do something unexpected with focus-visible outlines or the
`reel-more` "show N older" button's layout, (3) real contrast on the glass
skin's dimmest text tokens (`.reel-vs`, `.reel-dot` at 30-40% white) —
picked by eye against the exact background color, not checked with a
contrast tool, worth a second look before shipping as the default anyone
lands on via a shared `?skin=glass` link.

**Concurrency notes for whoever reads this next:** this worktree had all
four round-6 builders committing to the same physical directory at once
(not separate git worktrees — files from tasks 1/2/4 appeared on disk
mid-edit more than once). Every touch to `office.html` and `reel.js`
stayed inside this task's owned regions; `git pull --rebase` before each
of the two pushes both landed cleanly, no conflicts. `RUNG_INFO`'s removal
was checked against task 4's `replay-card.js` before pushing, specifically
because that file's own header comment says it copies reel.js's rung
colors — confirmed it's a hardcoded copy, not an import, so removing the
object didn't break it.

**Commits:** `add glass and ticker reel skins, cycle button`,
`add reel-skins-test harness for all three looks`.

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

## round 6 task 2 — dominance-beat variants: waveoff and slap

Built the other two "out-authoritied" beats the brief named alongside
shove: `clips/waveoff.js` (no contact at all — a slow, barely-turned
back-of-hand wave, loser deflates and shuffles back a step) and
`clips/slap.js` (cartoon slap — big telegraphed wind-up, a fast swing to
contact, loser's head whips and staggers, ends with a hand slowly
drifting up to the struck cheek). Same shape as shove.js throughout:
marks function + asymmetric clip pair, `a` always the winner. Harnesses
`clips/waveoff-test.html` / `clips/slap-test.html`, cloned from
shove-test.html (both use absolute `/glb/character.glb`, so neither
needed the relative-path fix task 1 flagged for the yield/doubletake
harnesses — that bug is specific to office.html, not these).

Wired into the rig, all append-only: `World.waveoff(a,b)` /
`World.slap(a,b)` directly below `World.shove` in `agent.js`, same
`(a,b)` signature and a-wins convention, `typeof`-guardable by task 4's
dispatch. Added `waveoff`/`slap` to `STAGE_MARKS` (the table at ~line
495 the brief pointed at) and to `ACTS`/`ACT_OF_CLIP`/`DOING` (the real
`const ACTS = {}` table, not literally at the brief's ~529 — that line
landed inside `STAGE_MARKS` in this tree's actual layout, so "ACTS
table" was read by identity, not line number). Also had to touch two
more spots in the shared `#step()` method that neither task's brief
named explicitly but that shove/chestbump/fistbump already extend for
the exact same reason: the settle-phase act-dispatch `if/else` chain and
`CLIP_OF_KIND`'s end-detection map. Skipping either would leave
`World.waveoff`/`World.slap` encounters stuck `busy` forever — not
optional plumbing, just unnamed in the brief. Task 1 (chestbump/fistbump)
hit the identical situation and made the identical kind of edit; no
conflict, `git pull --rebase` merged clean since we landed in different
branches of the same if/else and different keys of the same object.

**Real bug found and fixed via the browser, not by inspection:**
`waveoff.js`'s `milestone()` helper destructured `{ rightArm: ra, leftArm:
la }` but every call site in the same file passed `{ ra, la }` — a
plain key-name mismatch. Every arm pose in the file was silently a
no-op; the clip would have shipped with the winner's arms hanging at
rest through the entire "wave" for both the wave and the deflate-react
sides' arm reads (torso/hips fields were passed under their real names
and DID work, which is why the deflate/shuffle geometry tests I wrote
first all passed — nothing exercised the arm fields). Only caught it
because the round's own instructions insist on looking at a screenshot
of the harness rather than trusting the pose math; the "held on the
peak-wave frame" shot showed a dead arm at rest, which is not what the
authored SWEEP milestone looks like on paper. One-line fix
(`{ ra, la }` in the destructure), reloaded, re-screenshotted, confirmed
the arm actually sweeps out now.

**Slap contact tuned in-browser, twice.** First pass authored CONTACT/
FOLLOW poses by eye against shove.js's own THRUST numbers as a
reference, loaded slap-test.html, and the palm landed ~44cm from the
loser's head — nowhere near a hit. Rather than eyeball-adjust blind, did
a small in-page grid search (`evaluate_script`, reusing the running
scene's actual positioned pair, applying candidate poses via
`ANIM.applyPose` and measuring `palmPoint(...).distanceTo(headBone)`
directly) over lean/twist/hips-forward-lunge/shoulder/elbow — landed a
combination under 4cm. Baked those numbers into `CONTACT_Y_CM`/
`CONTACT_Z_CM`, which changed `SLAP_SPACING`, which moved the pair
further apart and undid the fit (44cm -> then a first attempt still only
got to ~24cm). Root cause turned out to be a second, separate problem:
`SLAP_KEYS=60` didn't happen to land a sample exactly on
`SLAP_CONTACT_T=0.50` (`(60-1)*0.5=29.5`, not an integer), so
`holdContact()`'s mixer-driven playback was interpolating between a
mostly-wound-up sample and the true contact sample and landing short —
the exact "mushes" failure mode `office-clips-geometry.test.ts` already
has a named rule for on doubletake's snap, just not one this file had
guarded against. Fixed by bumping to 81 keys (`(81-1)*0.5=40`, exact).
Re-verified in the harness after each change, not just re-derived on
paper: final palm-to-head at rest spacing is 9.4cm, screenshotted at the
held contact frame from a rotated camera angle (not just the default
back-of-both-heads preset every one of these harnesses ships with) —
the palm is visibly on the loser's cheek, not just numerically close.

**Browser verification, what was actually looked at (not just
triggered):** both harnesses loaded clean, zero console errors beyond
the pre-existing favicon 404 (harmless, unrelated). For slap: screenshot
of the windup-hold anticipation pose (arm cocked out to the side,
elbow bent, held), a rotated-camera contact-frame screenshot with the
palm visibly touching the cheek (9.4cm, matches the harness's own `ok`
threshold), and a post-contact follow-through frame showing the loser's
head turned from the whip. For waveoff: the pre-fix broken screenshot
(dead arm) and the post-fix screenshot (arm swept out, loser's head
already down) from a rotated angle, plus the clip's final frame (both
settled — winner's arm dropped back near rest, loser fully deflated).
Did not screenshot every intermediate segment boundary (GLANCE, RETURN,
STAGGER, DAZED) individually — timing/shape of those is covered by the
vitest geometry file's "holds still then moves" assertions instead,
consistent with how round 4 covered yield/doubletake's timing.

Shared browser lock: acquired after an ~12 minute wait behind
`featA-round4-reviewer` (the other feature's worktree had a stale vite
process still bound to 5173 from an earlier session — killed it per the
lock protocol before starting my own). Killed the server and released
the lock when done; did not leave it running.

Files owned this task: `clips/waveoff.js`, `clips/slap.js`, both
`.d.ts` (needed — `tsconfig.json`'s `allowJs` surface doesn't cover
`office/*.js`, same reason `yield.d.ts`/`doubletake.d.ts` exist; the
first typecheck run failed without them), both harnesses, `agent.js`'s
import block + the four append-only regions above. New test file
`web/test/office-clips-dominance-variants.test.ts` (20 tests, geometry +
timing/sequencing checks mirroring `office-clips-geometry.test.ts`'s own
shape). All 189 tests pass, `pnpm typecheck` clean. Pushed in three
commits: clips+harnesses+tests, the browser-driven pose/timing fixes,
the agent.js wiring.

Nothing filed as a GitHub issue this task — no edge case hit that was
expensive enough to defer; the two real problems found (the arm-pose
typo, the keyframe-straddling contact) were both fixed in-round since
they were caught early enough (before commit) to be cheap.
