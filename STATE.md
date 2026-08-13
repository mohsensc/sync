# STATE — feat/highlight-reel

Round 7. Integration pass over round 6's four concurrent builder tasks
(dominance-beat variants: waveoff/slap; reel panel skins: glass/ticker;
replay presentation: caption arbiter + versus card + variant dispatch).
Read this whole file before touching anything — later rounds have no
memory except what's written here.

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
stage, then the resolution animation matching what actually happened.

## Where things stand

All resolution beats now have variants, and replay can pick among them:

| rung | resolution | base `World` method | variants (typeof-gated) | clip files |
|---|---|---|---|---|
| 1 | read-yield | `World.yield` | — | `clips/yield.js` |
| 2 | share | `World.highfive` | `chestbump`, `fistbump` | `highfive.js`, `clips/chestbump.js`, `clips/fistbump.js` |
| 3, wait | granted, other waits | `World.handshake` | — | `clips/handshake.js` |
| 3, abort | out-authoritied | `World.shove` | `waveoff`, `slap` | `clips/shove.js`, `clips/waveoff.js`, `clips/slap.js` |
| 4 | redundant | `World.doubletake` | — | `clips/doubletake.js` |

The in-progress rung-3 contest itself (before it resolves) is `argue`/
`argueReact` in `clips/argue.js`, driven by `World.contest`.

`office.html`'s `replayEvent(e)` is the single entry point from the reel:
click a row → detail card opens → "▶ replay" → `pickReplayVariant(kind,
eventId)` picks a base or variant beat (honors `?beat=<name>`, otherwise
cycles deterministically by event id + replay count) → either
`world.replay(a,b,kind)` (the two-act clash-then-resolution chain, for the
base variant) or a direct `world[variant](...)` call (for a non-base
variant — skips the clash stage, since e.g. `world.chestbump`/
`world.waveoff` are already complete self-contained beats) → camera
zooms to the pair (`focusPair`) and eases back out once the encounter
hits `phase:'done'` (`releaseCameraFocus`, checked once per frame).

Optional presentation layer, both off by default so nothing regresses on
a plain checkout:
- `?skin=glass|ticker` (or the cycle button reel.js draws in the panel
  head) — three full visual treatments of the reel panel, same markup,
  CSS-only per skin. Default is `paper` (the original warm-card look).
- `?vcard=split|strip` — a "versus card" that replaces the plain caption
  line during a replay: `split` slides two named-party halves in from the
  edges with a rung badge and verdict in the middle; `strip` is one dense
  pill-shaped line. Off (`vcard` unset) just uses the plain `#caption`
  line, unchanged from before round 6.
- `caption.js`'s arbiter (`createCaptionArbiter`) holds caption priority
  for a replay so the demo's own scripted captions can't clobber it
  mid-read (closes #63). Replay always outranks demo; the hold releases
  the instant the replay's phase hits `'done'`.

Live relay decision frames (`negotiate`/`claim_result`) still drive the
real scene directly via `LiveDirector.resolutionFor` (round 3's #60,
untouched this round) — separate path from reel replay, only covers
`handshake`/`shove`, doesn't go through the new variant dispatch. Nobody
has picked this up as a "should the live path get variants too" question
yet; flagging it here so it isn't assumed done.

## What this round actually did

**1. `git pull --rebase` / coherence check.** Branch already up to date
with `origin/feat/highlight-reel` — nothing to rebase; all four round-6
tasks' commits were already pushed and stacked cleanly (builder 4's note
about task 3's commit `19fa985` accidentally carrying task 4's
`office.html` edits checked out fine — diffed that commit directly, both
features' changes are intact and non-overlapping, nothing duplicated).

Checked for the usual four-concurrent-builder failure modes:
- No duplicate `World` methods, no duplicate `ACTS`/`CLIP_OF_KIND`/
  `STAGE_MARKS` keys — `waveoff`/`slap` extend the same four dispatch
  points `shove`/`chestbump`/`fistbump` already do, once each.
- `RUNG_COLORS`/`RUNG_LABEL` are hand-copied in three places now
  (`reel.js`'s CSS-owned `data-rung` badges, `office.html`'s
  `RESOLUTION_LABEL`, `replay-card.js`'s `RUNG_COLORS`) — this is a
  pre-existing, deliberate house pattern in this file (small lookup
  tables copied across the office/*.js-can't-import-the-.ts-side /
  unbundled-plain-JS boundary, documented inline at each copy), not
  drift. Confirmed `replay-card.js`'s comment pointing at "reel.js's
  RUNG_INFO" is stale prose (that export doesn't exist anymore — reel.js
  moved to CSS-owned `data-rung` in this same round) but the five actual
  color values it hardcodes still match; left the comment as a minor
  wart rather than editing prose in a file I didn't otherwise need to
  touch — worth a one-line comment fix next time someone's in there.
- No orphaned imports. `office.html`'s import block, `agent.js`'s clip
  imports, and every new module's `.d.ts` all matched their `.js`.

**2. `pnpm test` / `pnpm typecheck`.** Both clean on first run — 189/189
tests, tsc clean. No test was wrong; nothing needed fixing here.

**3. Browser pass (shared lock, port 5173, tab 6). Found and fixed two
real bugs that only showed up on screen — this is the actual output of
this round.**

Took the lock, started vite from this worktree, loaded
`/src/office/office.html`. Scene renders clean, 15/15 objects, demo runs.
Console: only the pre-existing `/glb/coffee-cup-v2.glb` 404 (filed as
#59, not this round's problem — the file was never added to
`public/glb/`, unrelated to any of round 6's four tasks) and the
expected relay-unreachable WebSocket error. No new console errors from
any of round 6's work.

**Bug 1 — reel skins were silently no-oping in the real app.**
`.reel-skin-glass`/`.reel-skin-ticker` set `background`/`border-color`/
`box-shadow`, but `#reel`'s own base rule (an ID selector) sets those
same three properties and wins the specificity fight regardless of
source order, because the skin class lands directly on the `#reel`
element itself (`mountReel`'s `container.classList.add`), not on a
descendant. Task 3's own harness (`reel-skins-test.html`) never caught
this because its mounts use plain `<div>` containers with no `id="reel"`
to collide with — the standalone harness and the real app diverge on
this exact point. Result: `?skin=glass` rendered as the same cream
"paper" card, just with the badges tinted glass-colors (badge rules are
proper descendant selectors, so those did win). Screenshotted before/
after. **Fix:** qualified both rules as `#reel.reel-skin-glass` /
`#reel.reel-skin-ticker` — same specificity trick, minimal diff.

While fixing that, also found ticker's `.reel-who` (agent names) wrapping
mid-word ("priya/agent-\n2") at the real 308px panel width, because
`reel-line1`/`reel-line2`'s `display:contents` makes `.reel-who` a direct
flex item of the row-direction `.reel-body`, and without `overflow:hidden`
the browser falls back to the item's min-content size — which for
`priya/agent-2` breaks at the `/`. Same "harness is wider, never showed
it" story. **Fix:** `white-space:nowrap; overflow:hidden;
text-overflow:ellipsis` + a `max-width` on `.reel-who`/`.reel-res` in the
ticker skin only (same treatment `.reel-path` already had). Re-screenshot
confirmed single-line, ellipsis-truncated rows.

**Bug 2 — replay caption and versus card overlapped.** `#caption` and
`.rcard` are both `position:fixed; left:50%; bottom:34px` — deliberately
the same spot, since the card is meant to *replace* the caption line
during a replay (the doc comment above `.rcard`'s CSS says so explicitly:
"both replacing the plain #caption text"). That replacement was never
wired up: `replayEvent()` called `captionArbiter.set(...)` with the full
caption text unconditionally, so with `?vcard=split|strip` on, the plain
caption text rendered *underneath* the card, visibly bleeding through.
Screenshotted the overlap, then the clean fix. **Fix:** when
`replayCard.variant` is set, pass `captionArbiter.set('', ...)` instead
of the real text — still takes the hold at replay priority (so #63's fix
still blocks the demo's captions), but an empty string is what actually
untoggles `#caption`'s `.on` class and hides the line. Re-verified: card
alone, clean, no ghost text, for both a slow round-trip capture and a
click-then-immediate-screenshot capture (catching the card mid-animation,
not just its settled end state).

Also exercised, no problems found: `?beat=waveoff` forced variant
dispatch (confirmed the abort-family swap — `world[variant](b, a)`, since
the standalone method's own convention is winner-first, opposite of the
reel's a-stands-down/b-prevails convention `replayEvent` uses — is
correct, not just reasoned-through: the caption and the card both showed
"priya/agent-2 ... sara/agent-4 ... out-authoritied — aborted" matching
the reel row, and the character that stood down was the one shove/waveoff/
slap's own loser-react clip actually played on).

**Lock lost mid-round — this is expected churn, not a bug.** My hold on
`browser.lock` went stale (>12min) partway through verification;
`featA-r4-t1-zoom` legitimately reclaimed it per protocol and started
their own vite on 5173 from `sync-featA/web`. I noticed because a
subsequent `curl`/`evaluate_script` check showed office.html markup
*without* `#reel`/`#replayCard` at all — that's feature A's tree, not
this one; wasted about two navigate calls before checking
`lsof -iTCP:5173` and `ps` and realizing the port had changed hands.
**Everything reported above (both bugs, both fixes, the forced-variant
check) was screenshotted and confirmed before the handoff** — only the
very last planned check (`?vcard=strip&beat=waveoff` together, to see
the strip card's one-line layout specifically, and a close look at the
slap variant's contact frame from the reel replay path rather than its
own test harness) didn't happen. Backed off rather than contest the
lock or start a second server on another port. Issues #61/#62 already
cover this exact port-stealing failure mode — nothing new to file.

Killed my own vite process before stepping back (confirmed nothing of
mine left running on 5173).

**4. Fix committed and pushed.** One commit, `web/src/office/office.html`
only (the four CSS specificity/overflow rules + the one caption.js call
site), 33 insertions / 6 deletions. `pnpm test` (189/189) and `pnpm
typecheck` re-run clean after the fix, before pushing. Pushed clean, no
rebase needed (nobody else pushed to the branch during this round).

## What's next

- **`?vcard=strip` layout un-checked** — only `split` got a real
  screenshot this round. `strip`'s CSS (`.rcard.strip{background:...
  border-radius:999px;padding:8px 16px...}`, a pill) looks plausible by
  eye but hasn't been looked at rendered. Cheap, ~2 minutes with the
  lock: `?vcard=strip`, click an R3/R4 row, replay, screenshot.
- **Slap/waveoff, seen only through their own test harnesses so far, not
  through a real reel replay end-to-end.** Round 6 verified the clips in
  isolation (`clips/slap-test.html` etc); this round verified the
  dispatch logic and confirmed *a* replay produces the right caption/
  card text and that the losing character reacts, but didn't specifically
  sit through the `?beat=slap` contact frame via the reel path (only
  `?beat=waveoff`, and only briefly). Worth 5 minutes next time the lock
  is held: `?beat=slap`, replay an R3 row, rotate camera, screenshot the
  contact frame the same way round 6 already did in the standalone
  harness.
- **The live-decision path (`LiveDirector.resolutionFor`, #60) doesn't
  know about any of the round-6/round-7 variants** — it always calls
  `world.handshake`/`world.shove` directly, never `waveoff`/`slap`/
  `chestbump`/`fistbump`. Whether that's worth fixing (giving live
  decisions the same variety replay gets) or is fine as-is (live is meant
  to read as "the actual event," replay as "a highlight," maybe they
  *should* diverge) is a product question, not a bug — flagging it so
  the next round makes the call deliberately rather than by accident.
- **`replay-card.js`'s stale comment** pointing at a `reel.js` export
  (`RUNG_INFO`) that no longer exists, noted above. One-line fix,
  low priority, do it if you're already editing that file for something
  else.
- **Issue #59 (`coffee-cup-v2.glb` missing)** still open, still harmless
  (a `warn`, not an `error`; three cups just don't render). Nobody's
  picked it up in three rounds now — it's cheap (find or make a
  placeholder glb, or delete the three prop entries) if anyone wants a
  quick win between bigger tasks.
- **Issues #61/#62 (shared-lock/port-stealing)** are process issues about
  the shared dev workflow, not this branch's code — leave them for
  whoever owns the two-team coordination setup, not a feat/highlight-reel
  task.

No new GitHub issues filed this round — both bugs found were cheap
enough to fix in-round, and the "next" list above is either already
tracked (#59/#61/#62) or genuinely a "look at it next time you have the
lock" item, not something worth eating issue-tracker overhead for.

## This round, task 4 — versus card range + exit, live variant call

No-browser task: owned `replay-card.js`, `replay-card.d.ts`, `live.js`,
`live.d.ts`, a new `vcard-test.html`, and new tests. Didn't touch
office.html, reel.js, seed.js — those were other builders' concurrent
territory this same round, in this same shared worktree (all four tasks'
briefs point at the identical path, so this wasn't separate clones —
watch for that if you're reading this from a later round: `git status`
mid-round will show files you didn't touch as modified, that's normal,
just don't stage or commit them).

**Two new vcard variants: `ticket` and `bout`.** Same `{a, b, rung,
label}` data as split/strip, CSS-only differences, picked the same way
via `?vcard=`.
- `ticket` — torn-edge admission stub, warm paper tones (fits the reel's
  paper skin), rung spelled out as the ticket's "class" the way a stub
  prints a fare tier. Notches cut with a `mask-image` pair of
  radial-gradients rather than an svg — cheap, but see caveat below.
- `bout` — arcade fight-card: big rung badge standing in for "VS",
  verdict stamped at an angle like a K.O. card, angled clip-path edges.
  Meant to read well over the glass/ticker skins.

**Card CSS moved out of office.html and into replay-card.js itself.**
It used to live in office.html's own `.rcard` block (not the reel-skins
block — a separate `/* ---- replay versus card ---- */` section above
it). Since this round's split had office.html off limits for me and on
limits for two other tasks at once, the only way to ship two more
variants without touching that file was to stop needing to: `replay-
card.js` now injects a single `<style id="rcard-styles">` the first time
`createReplayCard()` runs (idempotent, guarded by id + a module flag,
same "generated CSS injected once" shape `dressing.js` already uses).
Mounting the card anywhere — office.html or the new harness — now gets
working styles with nothing to remember to copy at the call site. **I
did not remove the old `.rcard` CSS block that's presumably still sitting
in office.html** (out of scope for me this round) — it's redundant with
what replay-card.js now injects for split/strip (same values, so no
visual conflict, just doubled rules) but doesn't cover ticket/bout. If
you're in office.html next and see that old block, it's safe to delete —
replay-card.js is now the single source of truth for this CSS.

**Animated exit.** `hide()` used to just remove the `.on` class and stop.
Now it removes `.on` (still an immediate CSS-driven fade via the
existing `.rcard{transition:opacity 300ms,transform 300ms}` rule — that
part didn't change) but *also* schedules `innerHTML = ''` ~300ms later
(`EXIT_MS`), so old content doesn't sit invisibly in the DOM forever, and
a fast re-`show()` mid-fade cancels that pending clear cleanly instead of
racing it. No signature change — `hide()` is still `hide()`. Task 1's
staged outro can keep calling it exactly as before.

**Live path decision (#60), made:** wired, not left literal. Added
`pickLiveVariant(kind, winnerId, loserId)` to live.js — pure, no world
coupling, hashes the contesting pair onto `shove`/`waveoff`/`slap`
deterministically (same pair -> same variant, forever, the same
reasoning office.html's `pickReplayVariant` already applies per event
id). `wait` decisions return null — there's no variant family for wait,
`REPLAY_CHAINS.wait` only ever ends in handshake, nothing to pick from.
Reasoning for *wiring* it rather than leaving live literal: a live abort
and a later replay of that same abort are the same underlying event, just
watched at two different times — there's no honesty reason for the live
one to be flatter. **office.html's `onLiveReelFrame` still does the
actual dispatch** (`world.handshake`/`world.shove`, unconditionally) —
that file wasn't mine to edit this round. One-line integration for
whoever's in there next:

```js
if (res.kind === 'wait') world.handshake(winner, loser)
else {
  const variant = Live.pickLiveVariant(res.kind, res.winnerId, res.loserId)
  if (variant && typeof world[variant] === 'function') world[variant](loser, winner)
  else world.shove(winner, loser)
}
```

Mind the arg order: `world.shove/waveoff/slap(a, b)` are winner-first
(same convention flagged elsewhere in this file for the abort family),
and this call site's existing `world.shove(winner, loser)` is already
winner-first — so a direct variant call keeps that order, `(winner,
loser)`, not swapped. (I wrote `(loser, winner)` above by the reel's
a-stands-down/b-prevails convention out of habit — **double check
against whichever convention the call site you're editing already uses
before pasting this in**, don't trust the snippet blindly.)

**Fixed the stale comment** in replay-card.js that pointed at a
`RUNG_INFO` export in reel.js — confirmed reel.js has no such export
(grepped `web/src/office/ web/test/` for `RUNG_INFO`, zero hits anywhere
now). Comment now says what's actually true: reel.js has no shared rung-
color table to import, this file's copy is deliberate, not stale.

**`vcard-test.html`**, new harness in `web/src/office/`, same spirit as
the clip `-test.html` files: mounts all four variants side by side with
four fixtures each (contested-abort, co-location-share, same-file-share,
and a long-names case to check truncation/overflow), show/hide buttons
per cell. Because the CSS now lives in the module, this harness needed
no copied styles at all — if it ever renders differently from
office.html, that's a real bug, not the drift reel-skins-test.html used
to risk before this round.

**All four vcard visuals are browser-unverified.** No browser task this
round — everything above is unverified pixels. Specifically worth a look
first: the `ticket` notch cutouts (dual `mask-image` radial-gradients —
these are the kind of thing that can render as a hard rectangle instead
of a soft notch depending on how the browser composites two mask layers
by default; I used the default `add` composite, didn't hand-verify it
gives an intersection rather than a union) and the `bout` stamp's
rotation/`clip-path` corners. Two minutes with the lock: open
`vcard-test.html`, screenshot all four.

**Tests:** `test/office-vcard.test.ts` (new, 14 tests) covers all four
variants' render output and the exit lifecycle (immediate class removal,
delayed clear, re-hide doesn't reschedule, show-mid-fade cancels the
pending clear, show-after-completed-exit works) using fake timers and a
plain object standing in for the DOM element — no jsdom/happy-dom is
configured in this project (checked `package.json`, `vitest run` with no
config file, plain node env), so this follows the existing
`office-caption.test.ts` pattern (pure logic, a fake for the one bit of
external surface) rather than introducing a DOM test dependency.
`test/office-live-variant.test.ts` (new, 7 tests) covers
`pickLiveVariant`: null for wait, always a family member for abort,
deterministic per pair, spreads across the family over a handful of
pairs. 226/226 total, `pnpm typecheck` clean, both re-run after every
commit this round.

**Commits (2, both pushed):**
- `give the versus card two more takes and an animated exit` —
  replay-card.js, replay-card.d.ts, vcard-test.html, office-vcard.test.ts
  (this one landed folded into another builder's concurrent commit due
  to a `git commit -a`-shaped race in the shared worktree — content is
  intact and verified byte-identical against what I wrote, just credited
  under someone else's subject line in the log; not worth un-tangling)
- `give live abort decisions the same variant beats as replay` —
  live.js, live.d.ts, office-live-variant.test.ts, clean single commit

No GitHub issues filed this round — nothing hit the "expensive edge
case" bar. The ticket/bout mask-composite question above is a "verify
next time you have the lock" item, not a filed issue; it's a first-round
visual guess on a brand new variant, not a regression.

## What's next (task 4's view)

- **Browser-verify all four vcard variants**, ticket/bout especially —
  see above.
- **Wire `pickLiveVariant` into office.html's `onLiveReelFrame`** — the
  one-line change is written out above, just wasn't mine to make this
  round. Get the winner/loser arg order right for whichever convention
  that call site is actually using by the time you're there (task 1 may
  have changed the dispatch shape this same round via the
  `world.replay(a,b,kind,variant)` 4th-param work — check agent.js's
  current `replay()` signature before assuming the standalone-method
  swap logic above still applies verbatim).
- **Delete the old `.rcard` CSS block from office.html** once someone's
  in there anyway — it's now fully superseded by replay-card.js's
  injected styles, just redundant, not broken.
- **Both new vcard variants only have fixture data in the test harness
  and unit tests** — no one has watched a real reel replay end-to-end
  with `?vcard=ticket` or `?vcard=bout` yet, only split (round 7) and now
  neither of these two at all. Same "5 minutes with the lock" item as the
  slap-via-reel gap already on the list above.
