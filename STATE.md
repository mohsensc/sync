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

## Round 8, task 3 — reel severity sort, seed history, ticker two-line

Scope: `reel.js`, `seed.js`, their `.d.ts`, their tests, and only the
`/* ---- reel skins ---- */` CSS block in `office.html` (plus
`reel-skins-test.html`, called out explicitly as mine too). No browser —
everything below is verified via `pnpm test` / `pnpm typecheck` only.

**1. Severity sort.** `ReelStore` gained `sortMode` — `'new'` (default,
today's chronological order, unchanged), `'worst'` (rung descending,
newest-first as the tiebreak within a rung), `'worst-grouped'` (same
order, with a rung divider drawn between groups in the render layer).
A second cycle button sits next to the skin button in the panel head,
reusing the `.reel-skin-btn` class so it needed zero new CSS anywhere —
that also meant the group-divider markup (`groupHeadHtml` in reel.js)
had to be inline-styled rather than given its own class, since I don't
own office.html's base CSS to give it a home; it reuses the existing
`.reel-badge[data-rung]` rule (already themed per rung by every skin) for
its only meaningful color, so the divider looks right under paper/glass/
ticker without any skin-specific work. Filters and sort compose — sort
runs after the rung/human filter, not instead of it. Changing sort mode
does *not* reset the reveal cap (unlike changing a filter): re-ranking
the same set of rows shouldn't punt you back to the top of a list you'd
already paged into. Unit tests cover: default, fallback-to-'new' on a bad
value, correct rung-desc ordering, the newest-first tiebreak within a
rung, worst-grouped sorting identically to worst (grouping is a render
concern, not a data one), sort respecting active filters, and reveal-cap
behavior on a mode switch. All in `office-reel.test.ts`.

**2. Seed history.** Reconciled seed.js's stale "not imported anywhere
yet" header — office.html has imported it since round 6
(`new ReelStore([...SAMPLE_EVENTS, ...seedEvents()])`); the header was
just never updated to say so. Grew `seedEvents()` from 25 to 75 (86
total with reel.js's own 12 `SAMPLE_EVENTS`), which clears
`REVEAL_STEP` (40) with real room to spare — "show older" and the
long-list tail are now actually reachable on a fresh checkout, not just
in a long-running session. Made it uneven on purpose rather than tuning
by hand and hoping:
- rung distribution weighted 0.30/0.24/0.20/0.16/0.10 (rung 0 through 4)
  instead of a flat `i % 5` — "co-location happens constantly, a
  contested symbol is rare," per the collision ladder in the brief.
- timestamps staged into three bands (last hour / next ~10h / out to ~4
  days) instead of one flat random window — a uniform draw over multiple
  days rarely lands inside the last hour by chance, so recency needed to
  be forced, not hoped for.
- sara is deterministically kept out of every rung-4 event (`
  pairExcludingHuman`, bounded-retry with a deterministic fallback) —
  the brief asked for at least one human×rung filter combo that's
  provably empty, not just empty by luck. reel.js's own `SAMPLE_EVENTS`
  already agreed by coincidence (neither of its two rung-4 rows involves
  sara); this makes it a guarantee.
Still fully deterministic (same mulberry32 PRNG, no `Math.random`
anywhere) — `office-seed.test.ts` still checks that directly. New tests:
count is 75, skewed toward low rungs, spans minutes to multiple days,
sara+rung4 is always empty. New integration describe block in
`office-reel.test.ts` builds a real `ReelStore` from
`[...SAMPLE_EVENTS, ...seedEvents()]` and checks paging actually
triggers (`page().remaining > 0` at the default cap), `showMore()`
eventually reveals everything, the sara+rung4 combo filters to `[]`
through the store's real filter methods (not just checked on the raw
array), and — the brief's own named failure mode — that it is *not* the
case that every human×rung combination is populated.

**3. Ticker skin, two lines instead of one.** The one-line version
(`display:contents` merging line1/line2 into a single 288px-wide flex
row) was reviewed at the real panel width and read as "priy… vs dev… —
split the …" on five of seven rows — a dozen-ish characters of budget
per field once R-badge + who + vs + who + path + dot + res + time are
all fighting for the same line. Went with "drop the one-line ambition,
go two-line dense" per the brief's own framing, over "drop a column" —
dropping path or res would have thrown away information the paper/glass
skins keep, and the whole point of ticker is density, not a lesser
feature set. Removed the `display:contents`/`flex-direction:row`
overrides so the base column layout (line1 above line2) stands, then
tuned padding/gap/font-size down to keep the terminal feel. Kept modest
`nowrap`/`ellipsis`/`max-width` on `.reel-who` (118px) and `.reel-path`
(150px) as insurance even though each field now has a full line to
itself — cheap, and it's exactly the assumption that broke last time.
**Unverified in browser** — this is a CSS-only, no-browser round; the
next round holding the lock should load `?skin=ticker` (or
`reel-skins-test.html`) and confirm it actually reads clean at 308px,
not just "shouldn't overflow by the math."

**4. `reel-skins-test.html` resync.** Owned this file already (called
out explicitly in the brief) but it had drifted since round 6 — missing
both of round 7's real fixes (`#reel` specificity on glass, `.reel-who`
nowrap on ticker) because this harness mounts `<div class="reel">`
panels, not `<div id="reel">`, so it never shared the bug that specific
fix was for. Resynced properly this time: kept the class-only selectors
(no `#reel.` prefix — genuinely doesn't need it here, documented why
inline so the next person doesn't "fix" it into a mismatch with the
real markup), carried the two-line ticker rework over, and fixed the
same `.reel-row` `width:100%` + `padding` content-box overflow bug
office.html had (28px overflow, clips the timestamp) independently in
this file's own copy. Also pinned `.col`'s width alongside its
flex-basis so the mount is defensibly 308px, not just "should be by the
flex math" — the brief flagged this exact divergence as the root cause
of two shipped bugs, so belt-and-suspenders felt right here specifically.

**Process note — shared worktree collision, not a code bug.** Early in
this round, `git add <my files>` followed by a separate `git commit -m`
picked up other agents' uncommitted WIP (task 4's `replay-card.js` edits
and a `vcard-test.html` in progress) because all four builders share this
exact working directory and object database — the index can change
between an `add` and a `commit` issued from a different agent's shell.
Caught it before pushing (the commit's file list was obviously too wide),
`git reset --soft HEAD~1`, `git restore --staged` on the files that
weren't mine, and recommitted with an explicit trailing `-- <pathspec>`
on `git commit` itself instead of a separate `git add` step, which is
race-proof against this. Between that soft-reset and the recommit,
another agent apparently picked up the *original* bad commit before I
un-staged it (origin briefly had a commit bundling my reel/seed work with
task 4's WIP replay-card.js under my message) — task 1 or task 4 cleaned
it back out in a follow-up commit before I even pushed, so nothing landed
broken, but if anyone digs through `git log` and sees a commit that looks
wrong, that's why. No data was lost; every file's final content on origin
matches what its owning task actually wrote. **Recommendation for future
rounds sharing this exact setup: always pass files as a trailing
pathspec on `git commit` directly, never a bare `git commit -m` after a
separate `git add`.**

**Tests / typecheck.** `pnpm test`: 257/257 green, including 20 new tests
across `office-reel.test.ts` and `office-seed.test.ts` for this round's
work. `pnpm typecheck` was red at push time, but not from anything in
this task's scope — `office-clips-sustain.test.ts` and
`office-clips-unloved-variants.test.ts` (task 2's territory: tiptoe/
facepalm clips, still missing a `.d.ts` at the time) were the only
failing files. Confirmed by reading the error output directly — no
mention of reel.js, seed.js, reel.d.ts, seed.d.ts, office.html, or
reel-skins-test.html anywhere in it.

## What's next (task 3's leftovers)

- **Ticker two-line rework needs eyes** — see above, CSS-only round,
  nobody has looked at it rendered yet.
- **`worst-grouped`'s inline-styled divider** is a reasonable v1 but a
  real CSS home (even just a class in whatever base-CSS file ends up
  covering it) would be cleaner than inline style attributes long-term —
  not worth blocking on, flagging for whoever's next in office.html's
  base block.
- No new GitHub issues filed this round — everything found was in-scope
  and cheap enough to fix directly (the seed reconciliation, the ticker
  rework, the harness resync) rather than defer.
# STATE — feat/git-aware-characters

Round 6 starts here. Round 5 was the integrator pass over round 4's four
parallel tasks (zoom/focus/framing, churn heat/cold + zoneowner rug default,
gitapi email dedup + per-line blame + source route, blamecard timeline
stacking/single-owner/gutter variant). No merge conflicts, no dead code
found, nothing needed fixing in code — this round was verification plus a
rewrite of this file. Read this before touching anything — round 6 has no
memory except this file and `git log`.

## Where things stand

Branch coherent, everything from round 4 already merged and pushed by the
time this round started (`git pull --rebase` was a no-op, worktree was
already at `origin/HEAD`). No duplicated helpers, no half-merged edits, no
dead imports — four builders landed cleanly onto disjoint files (gitapi.mjs
was task 3 alone; blamecard.js/history-viz.js was task 4 alone; office.html/
interact.js/zones.js was task 1 alone; gitsignals.js/dressing.js/zoneowner.js
was task 2 alone). The only real cross-task dependency — task 4's gutter
variant needing task 3's `/api/git/source` + `blame?lines=1` contract —
landed correctly; confirmed live, see below.

`pnpm test` — 237/237, 12 files, unchanged from round 4's own count (nothing
broke, nothing needed re-testing). `pnpm typecheck` — clean. Both verified
fresh at the start of this round, before any browser work.

No new commits from this round's code side — there was nothing to fix. This
file is the only change.

## Verified live this round

Took the browser lock, and hit issue #61/#62's exact failure mode myself,
a third time (task 1 hit it round 4, task 2 hit it round 4, now the
integrator too): held the lock, started the server, navigated, and midway
through a sequence of `evaluate_script` calls the tab's URL silently changed
out from under me (`?beat=chestbump&vcard=split&skin=ticker` appeared with
no `navigate_page` call from this session) and `window.__focusMode`/
`__zoomMode`/`__gitSignals` all went briefly undefined before coming back.
Checked the lock dir immediately after — it was gone, `rmdir`'d by someone
else, despite my `since`/`owner` files having been written correctly
seconds before. Re-acquired, restarted the server (mine had been killed by
the other side's `pkill -f 'vite.*5173'` on release), and got clean
verification on the second attempt. Not filing a fourth issue for this —
#61/#62 already cover it — but flagging that this is not a rare edge case,
it is now 3-for-3 across two rounds. Worth round 6 or later actually fixing
the lock (e.g. a `trap` that never releases-then-reacquires quietly, or a
lock that records a PID and refuses to be removed by anyone else while that
PID is alive) rather than just working around it again.

Once cleanly on this worktree's server, confirmed with real interaction
(mostly via `window.__zoomAgent`/`__clickAgent`/`__setCam`/`__gitSignals`/
`__zoneOwner` — the console-driven test surface every prior round has been
building up, and it's good: precise, no raycast-picked-the-wrong-agent
flakiness once you use `__zoomAgent` instead of `__clickAgent`):

- **Focus mode** (task 1): default on. Zoomed `a2` — screenshot shows just
  the character and the blame card, no zone pill, no zoneowner root, no
  caption, no corner panel. Pressed `F`, zoomed again (well, the demo had
  auto-advanced to "done" by then, tried a fresh `__zoomAgent` call) —
  confirmed the pile-up: corner panel, all eight zone pills, and the blame
  card all visible simultaneously. Toggle works both directions.
- **Head framing** (task 1): `threequarter` (default) on `a2` lands close
  and forward-facing on a desk sitter — matches issue #64's documented
  limitation, this is the "closer to the arc" case that works. `shoulder`
  mode on `a1` gives the wider over-the-shoulder view, screenshotted
  cleanly, matches the round 4 description exactly.
- **Stale hover / CSS fix / yaw wrap** (task 1): no direct re-test this
  round — task 1's own round-4 verification already covered this with
  dispatched pointer events, and nothing downstream touches that code path,
  so didn't re-walk it.
- **gitapi source + line blame routes** (task 3): watched the network panel
  during a gutter-variant render — `/api/git/source?path=...&start=200&
  end=230` and `/api/git/blame?...&lines=1` both fired and both returned
  200 with real bodies. Every `/api/git/*` route hit during this session
  (stat, churn, shortlog, blame, log, source) came back 200, none 404,
  none threw. Confirmed the shortlog dedup directly too:
  `window.__zoneOwner.mode` reads `'rug'` and the "desks"/"vault"/
  "whiteboard" zone pills all read "mostly mohsensc" (one name, not split
  across `mohsensc`/`Mohsen Sarrafan Chaharsoughi` the way it would without
  the email-based merge) — dedup is doing its job in the live app, not just
  in the unit tests.
- **Churn heat/cold treatments** (task 2) — **functionally confirmed,
  visually unconfirmed, and that's worth reading carefully.** Pressed `C`
  to cycle to `heat`, waited for the poll+ease to settle, then reached
  directly into the THREE.js scene graph (`world.byId('a2').root.
  getObjectByName('desk-heat')`) rather than trusting a screenshot: the
  group's `visible` was `true` and its four child meshes had real,
  animating, non-zero opacities (0.02–0.27, moving between calls — the
  breathing/drift `update(dt)` loop is genuinely running). But in an actual
  screenshot of that same zoomed-in a2, at normal framing, I could not
  visually pick out any glow or steam by eye — it reads as empty desk. This
  is real, rendering, correctly-computed content that is too subtle at this
  opacity range / this camera distance to land as a visible feature. Task
  2 themselves never got to see it either (their own report says so).
  Recommend round 6 either turn the opacity up materially (0.12–0.27 is
  faint against this scene's warm-beige palette) or do a proper close
  framing pass on it before calling it done — right now it is correct but
  invisible, which for something in the "beautiful, iterate on many ideas"
  brief is close to not existing. Cold treatment: confirmed it correctly
  shows nothing on `a2` (real file, 5 days old, threshold starts at 60) —
  matches task 2's own documented note that the repo isn't old enough yet
  for cold to have real demo data. Not a bug.
- **Zoneowner rug default** (task 2): `window.__zoneOwner.mode` is `'rug'`,
  confirmed via API. Same subtlety problem as heat/cold: didn't get a
  screenshot where the rug reads as visually distinct from the room's
  pre-existing pastel zone-floor tint (that pastel circle-per-zone floor
  treatment is a much older feature, unrelated to this round). Might just
  need a closer camera angle to actually see it; didn't chase it further
  this round.
- **Blamecard gutter variant** (task 4): cycled `V` twice from the default
  (`graphic` → `classic` → `gutter`) on `a3` (a genuinely tracked file,
  `web/src/office/anim.js`). Real source rendered: line numbers, real code
  text (`const axis = FOREARM_ROLL[bone]`, etc.), dark editor-style
  background. No crash, no console error, no fallback triggered. Long
  lines run off the card's right edge in a screenshot, but
  `.code-gutter{overflow-x:auto}` is already set in the CSS — that's
  scrollable-by-design, not a bug, just didn't test the actual scroll
  gesture.
- **Single-owner blame collapse** (task 4): selected `a1`
  (`python/src/agent_presence/__init__.py`, one commit, one author) —
  blame card showed "no history here yet" / "select an agent holding a
  line range" copy correctly rather than a tug-of-war bar with one side.
- **Small cross-surface inconsistency, not a bug, not filed**: zones.js's
  2D zone-label pills (pre-existing, round 2/3 feature, untouched this
  round) always say `"mostly <name>"` regardless of author count. task 2's
  zoneowner.js 3D rug/plaque says `"all theirs"` for a real single-owner
  zone. Two different UI surfaces describing the same fact with different
  confidence language. Cosmetic, cheap to unify later, not worth a round of
  its own — noting it so it isn't rediscovered from scratch.
- **Console/network**: no errors traceable to round 4 code. The only
  console noise is pre-existing and already tracked: `coffee-cup-v2.glb`
  parse warning (issue #59), the relay-unreachable websocket error
  (expected — no relay running, demo mode is correct behavior), and a
  `favicon.ico` 404 (harmless, not worth an issue).

## Key registry (current, no collisions)

B (histshelf) / C (churn treatment) / F (focus mode) / H (hover treatment) /
R (blame region) / T (desk tint) / U (zone ownership) / V (blame variant) /
Z (zoom feel) / Escape (deselect). `?focus=off`, `?frame=`, `?churnMode=`,
`?zoMode=`, `?bcVariant=` are the matching query params.

## What's NOT built yet / still genuinely open

- **Churn heat/cold visual strength** (new finding this round, not filed as
  an issue — it's a tuning pass, not a bug someone needs to design around):
  the treatment is correctly wired and animating but reads as invisible at
  normal camera distance and this scene's palette. Round 6: turn up
  opacity, or find the right close framing, before spending more time on
  further churn-mode work on top of it.
- **Zoneowner rug visual distinctiveness**: same flavor of issue, unverified
  either way this round — someone should get an actual before/after
  screenshot of rug-vs-plaque next time the lock is held for more than a
  few minutes.
- **#64**: threequarter head framing can't reach a face-on shot for
  characters facing away from the room's valid camera arc — front-row desk
  sitters, concretely. `shoulder` mode is the practical workaround today.
  Still open, still accurate, re-confirmed this round (didn't re-test the
  exact geometry, but nothing since round 4 touches this code).
- **#62 / #61**: shared port 5173 / shared lock gets stolen mid-session.
  Hit personally this round, third occurrence logged across two rounds.
  Not re-filing, but flagging severity: this is now costing every round
  real time re-acquiring and re-verifying. Worth fixing outright rather
  than working around again — see the "Verified live" section above for
  one concrete idea (PID-guarded lock).
- **#59**: `coffee-cup-v2.glb` 404/parse-failure, still open, still
  cosmetic-only. Curiously showed as HTTP 200 in this round's network
  panel (vite may be serving *something* at that path now) but the console
  still logged a JSON-parse-style failure loading it as a GLB — hasn't
  actually been fixed, don't take the 200 status as evidence it has been.
- **Symbol-level blame beyond a line range**: unchanged — still upstream of
  this branch (C++ hook / Go relay don't populate `region.start`/`end` on
  real presence frames yet).
- **Three-plus independent client-side git-data fetchers, no shared cache**:
  still true, still cheap at this repo's size, still not worth a standalone
  task. The dev-server network panel this round showed the same
  stat/churn/shortlog calls repeating every ~1.5s across three separate
  pollers (gitsignals.js's own tick, zoneowner.js's own tick) — fine for
  now, would start to matter if this ever points at a much bigger repo.
- **zones.js pill text vs zoneowner.js rug/plaque text disagree on
  single-owner phrasing** — see "small cross-surface inconsistency" above.
  Cosmetic, cheap, not urgent.

## Filed this round

Nothing. Nothing found needed a new issue — the lock/port contention is
already covered by #61/#62, the coffee-cup thing is already #59, and the
churn/rug visibility findings are tuning notes, not bugs blocking anyone,
so they're recorded here instead for round 6 to pick up.
