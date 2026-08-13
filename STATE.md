# STATE — feat/git-aware-characters

Round 3 starts here. This is an integrator pass over round 2's four parallel
builders (churn endpoint + blame ranges, ambient churn signal, blame card
rebuild, desk ownership tint). Read this before touching anything — round 3
has no memory except this file. I trimmed round 1's detailed play-by-play
out of this file; PR #57 and git log still have it if you need the history.

## Where things stand

The branch is coherent. `git pull --rebase` was a no-op — already in sync
with origin, no divergence. All four round-2 builders' work is committed
and pushed (`c876be9`..`09a7053`, then this round's `c7e995b` on top).

Checked for the usual four-way-concurrent-worktree damage (conflict
markers, half-applied edits, duplicate helpers under different names, dead
imports) and found none:

- `grep`'d every `.js/.ts/.mjs/.html` under `web/` for `<<<<<<<`/`=======`/
  `>>>>>>>` — clean. The conflict-marker scares all four builders logged
  (stash races corrupting `interact.js`, `STATE.md`) got resolved before
  landing.
- `node --check` on every `office/*.js` file plus the extracted inline
  module script from `office.html` — all clean syntax.
- Field-name audit: `gitapi.mjs`'s response shapes (`owners`, `share`,
  `newestLineAgeDays`/`oldestLineAgeDays`, `recent`/`working` churn body)
  match what `interact.js`, `blamecard.js`, `gitsignals.js`, and their
  `.d.ts` files declare, end to end. No stale field names anywhere.
- `gitapi.d.mts` has a declaration for every export `gitapi.mjs` actually
  has (`parseChurnLog`, `parseNumstat`, `blameRangeArgs` all present) —
  task 1's own note that this might drift never became real.
- Only one genuine leftover: `web/src/office/README.md` is 73 lines,
  already over the 50-line house cap, and doesn't mention any of round 2's
  new files (`gitsignals.js`, `blamecard.js`, `history-viz.js`,
  `interact.js`'s ownership additions). Pre-existing debt, not introduced
  by any of round 2's builders (none of them touched it). Not fixed this
  round — out of scope for an integration pass, flagging so round 3 doesn't
  have to rediscover it. If someone's in there anyway, this needs trimming
  *and* rewriting, not just appending — it's already over cap.

`pnpm test` — 111/111 passing, 9 files. `pnpm typecheck` — clean. Both are
the real commands from the brief, no workarounds needed.

## Two real bugs found and fixed this round

Both were flagged as known gaps by round 2's own builders but blocked on
file-ownership boundaries within that round. As integrator I own the whole
tree, so fixed both, one commit (`c7e995b`, pushed):

1. **Live-mode `gitPath` only ever got set once, at spawn.** `onLivePresence`
   in `office.html` looked up or spawned the agent, then went straight into
   the contest/state-machine logic without ever touching `a.gitPath` again.
   A live agent that moved to a different file mid-session kept the hover
   card / blame card / churn signal pinned to whatever file it *arrived*
   on. Round 2 task 2's builder flagged the exact one-line fix and its
   location but couldn't apply it (task boundary said don't touch
   `office.html` that round). Fixed: `a.gitPath = info.path` right after
   the spawn-or-lookup line in `onLivePresence`, so every frame keeps it
   current.
2. **`freshHalo` and the churn props (tray + paper block) leaked their
   geometry on every live-agent despawn.** `despawnLive` explicitly
   disposes `a.halo`'s geometry and material, but `freshHalo` (added an
   earlier round) and `churnTray`/`churnPapers` (added round 2 task 2) all
   get their own fresh, non-shared geometry in the `Agent` constructor —
   and nobody added matching dispose calls when those props were added.
   The material-only `root.traverse()` a few lines up in `despawnLive`
   catches materials for every mesh under `root` (so those weren't
   leaking), but geometry disposal was never wired for anything past
   `halo`. Only matters in live mode (demo-cast agents never despawn), but
   it's a real leak on every join/leave in a long-running live session.
   Fixed by adding explicit `.geometry.dispose()`/`.material.dispose()`
   calls for all three props, same pattern as the existing `halo` lines.

Both fixes are in `web/src/office/office.html` only. Reran `pnpm test` and
`pnpm typecheck` after — still 111/111 and clean.

## Browser verification: SKIPPED this round, and why

Tried, in good faith, for the full 20-minute budget the protocol allows
before you're supposed to give up:

- First `mkdir` attempt: lock already held by `featB-task2-replay`
  (~4 min old at that point, well under the 12-minute steal threshold).
- Waited it out via a background poll loop + Monitor, checked back
  periodically — still held by the same owner 8 minutes later.
- Ran one more direct foreground wait (up to ~10 minutes) — the lock
  finally freed partway through, but a different featB builder
  (`builder1-featB-motion`) took it in the same window before my loop's
  next `mkdir` landed. Lost the race.
- Total elapsed across all three attempts: right around 20 minutes. Per
  the protocol's own escape hatch ("If you can't get the lock in 20
  minutes, skip browser verification this round, write down what you
  wanted to check, and carry on with code work"), stopped there rather
  than camping the lock indefinitely or starting a second dev server /
  second tab, both of which are explicitly forbidden.

**What round 3 should check first, in priority order, once the lock is
free** (none of this is verified live yet — round 2's four builders each
did their own scoped browser checks per-file, described in PR #57's
history / prior STATE.md revisions if you need the detail, but nobody has
looked at all four round-2 features rendered together in the same room,
and nobody has looked at this round's two fixes at all):

1. **The two fixes above, specifically.** For the gitPath fix: in live
   mode (or fake it via `window.__live.onPresence(...)` with a synthetic
   frame carrying a new `path` for an already-spawned agent id), confirm
   the hover card / blame card actually update to the new file rather than
   sticking to the spawn-time one. For the despawn leak: spawn and despawn
   a live agent a few times (`spawnLive`/`despawnLive` are both on
   `window` implicitly via the module scope — check if they're exposed on
   `window.__live` or add a temporary console call) and check
   `renderer.info.memory.geometries` doesn't creep up across cycles.
2. **All four round-2 features together, one scene.** Blame card's new
   `graphic` variant (V key toggles `graphic`/`classic`) rendered on top of
   the desk ownership tint (steady vs. `breathe`, T key) with the churn
   paper-stack props visible on a busy agent (`agent2` /
   `cpp/hook/hook.cpp` was flagged last round as the strongest real signal
   to check, ~1.0 churn intensity) and the freshness halos all active at
   once — nobody has screenshotted this combination. Individually each
   piece was verified in isolation by its builder; the combination is the
   actual "does round 2 read as one coherent feature" question and it's
   still open.
3. **Churn visuals specifically** (typing speed 1.0x-1.6x while typing,
   paper stack height) — flagged as fully unverified by task 2's builder
   (no lock slot that round, and the logic can't be checked outside a real
   browser — no test in this repo instantiates a real `Agent`). Still
   unverified now. `window.__zoomAgent`-adjacent hooks or a stat-panel
   check on `agent2` is the fastest way in.
4. Standard sweep: `list_console_messages` clean apart from the two known
   pre-existing ones (`coffee-cup-v2.glb` 404 — filed as issue #59, not
   this branch's to fix; relay websocket `ECONNREFUSED` in demo mode,
   expected).

Lock protocol note for round 3: the other feature team (`featB`,
`feat/highlight-reel`, worktree `sync-featB`) is actively driving the
shared 5173 port and tab hard right now — saw two different owner labels
(`featB-task2-replay`, `builder1-featB-motion`) inside one 20-minute
window. Budget real contention time, not just the mechanical wait.

## Known duplication, deliberately not collapsed (documented repeatedly by
## round 2, still true, still not worth a standalone task)

Three independent client-side caches now fetch overlapping git data with no
shared cache between them: `interact.js`'s hover card (`/api/git/stat`,
30s TTL) and its newer ownership line (`/api/git/blame`, 60s TTL),
`gitsignals.js`'s ambient poll (`/api/git/stat` + `/api/git/churn`, 20s
interval), and `blamecard.js`'s own blame fetch on zoom. All local `git`
calls against a small repo, all cheap, all degrade fine independently.
Worth collapsing into one shared client cache module *if* a future round
is touching two or more of these files anyway — not on its own.

## What's NOT built yet (still open, untouched this round)

- **Symbol-level blame.** `gitapi.mjs`'s `blame` route has taken optional
  `start`/`end` line-range params since round 2 task 1, but nothing calls
  it with a range — the presence protocol still has no line-range field on
  a `Region`. Endpoint-ready, not wired to anything.
- **Diffstat / "how much did this just change" ambient signal beyond
  churn** — churn (task 2) covers this in spirit now; if there was a
  separate ask here it's superseded.
- **Live-only despawn leak class**: fixed the two known instances
  (`freshHalo`, churn props) this round. Worth a quick grep for any other
  per-instance-geometry prop added to `Agent` in a future round that
  doesn't get a matching dispose line in `despawnLive` — this is an easy
  class of bug to reintroduce since `despawnLive` doesn't loop over a
  registry of disposables, it just lists them by hand.

## Nothing filed as a GitHub issue this round

Both bugs found were one-liners, fixed inline rather than deferred. Issue
#59 (missing `coffee-cup-v2.glb`) was already open from a prior round and
is still the only open issue against this branch's work.

## Browser/port discipline

Followed the protocol exactly: never started a second dev server, never
opened a second tab, wasn't holding the lock when giving up (never got
it), didn't leave a stale lock behind (`mkdir` never succeeded, so there
was nothing to clean up). Full 20-minute wait spent honestly, documented
above rather than silently skipped.

## Round 3, task 1: file history as a bookshelf (`histshelf.js`)

Built the seed idea's "look at a file's history in-scene" piece: when an
agent is selected, their file's commit log renders as a physical shelf of
book spines — one per commit, colour by author (same hash as
`colorForAuthor`), height/lean by age, newest nearest the agent. Two full
treatments behind one key toggle, per the brief.

**New files**, all mine this round:
- `web/src/office/histshelf.js` — pure layout (`spineFor`, `layoutShelf`,
  `spineOffset`, `shelfWidth`) plus two renderers: `buildSpines3D()` (thin
  `THREE.Mesh` boxes on a shared plank, shared `BoxGeometry` scaled per
  instance — same pattern `dressing.js` uses for its ~120 meshes) and a DOM
  film-strip (`renderFilmStrip`, screen-projected every frame via the
  module's own small `requestAnimationFrame` loop, not office.html's
  `tick()`). `attachHistShelf({ scene, camera, canvas, fetchFn })` ties both
  to one `show(agent)`/`hide()`/`setMode()` API, fetches
  `/api/git/log?path=...&n=12` with a per-path cache (same shape
  `blamecard.js` already consumes), and degrades explicitly: 0 commits
  renders nothing, exactly 1 renders a single "dusty tome" lying flat
  instead of a shelf with one spine on it looking broken.
- `web/src/office/histshelf.d.ts` — hand types for the layout surface,
  following the `history-viz.d.ts`/`agent.d.ts` pattern so a typechecked
  test can import a plain-JS office file.
- `web/src/office/histshelf-test.html` — fixture harness, same shape as
  `blamecard-test.html`: canned `/api/git/log` JSON, a real (small) THREE
  scene with a marker cube standing in for the selected agent, five
  fixtures (12-commit, 3-commit, 6-commit/3-author, 1-commit, 0-commit),
  drag-to-orbit camera, mode button plus the same key toggle office.html
  wires up.
- `web/test/histshelf.test.ts` — 16 pure-function tests: empty/single/
  normal degrade paths, maxSpines capping and ordering, age-to-height/lean
  mapping at both ends of the band and mid-band, missing-author fallback,
  spine spacing/row-width math, author colour determinism and spread.

**Key toggle collision, caught and fixed mid-round**: picked H first
(mnemonic: history), then a `git pull --rebase` pulled in task 3's
concurrent `interact.js` change, which had *also* claimed H that same
round for cycling the three hover-card treatments. Moved histshelf to B
(bookshelf) before pushing — `?hsMode=strip` param, the in-file comment,
the fixture harness's button label, and the README line all updated
together in one follow-up commit. Grepped every `e.key ===`/`e.key !==` in
`web/src/office/*.{js,html}` after the fix; full live set now is B/H/R/T/
U/V/Z/Escape, one owner each, no other collisions.

**office.html wiring** (append-only, per the file-ownership split this
round): one `// --- histshelf wiring ---` fence at the very end of the
main module script, after task 3's `window.__zoomAgent` block and before
task 2's later `// --- zoneowner wiring ---` fence. Couldn't hook the
existing `interaction.select()` -> `onSelect` callback directly (that
callback is defined earlier in the shared file, inside `setupCast()`,
out of this round's append-only slice — reassigning it here would just
clobber whatever it already does). Instead the wiring block polls
`interaction.selected` every 150ms and diffs against the last agent it
showed a shelf for, calling `show()`/`hide()` on change. Cheap (one
reference comparison), and catches every selection path uniformly —
real clicks, Escape/deselect, and the console's `__zoomAgent()` — since
all three already funnel through `interaction.select()`.

**README**: was 73 lines and missing every round-2/3 file per round 3's
integrator note. Rewrote to exactly 50 lines (the cap), added one-line
entries for `gitapi.mjs`, `history-viz.js`, `blamecard.js`,
`gitsignals.js` and `histshelf.js` alongside the existing rig/trap notes,
trimmed the old "Seen working in a browser" prose section down since it
was changelog, not reference.

**Browser: not done this round**, per the task assignment (BROWSER: NO,
vitest + typecheck only). What a browser round should check first:
1. Both treatments actually rendering — `histshelf-test.html` exercises
   the layout math and a synthetic THREE scene, but nobody has looked at
   the 3D spines or the DOM strip positioned against a *real* character
   and desk in `office.html` itself. The shelf-position heuristic
   (`SHELF_Z_PUSH`, comment in `histshelf.js`) pushes away from the
   room's centre aisle as a stand-in for "behind the desk" — reasonable
   on paper for the two existing desk rows, unverified in the room.
2. The DOM strip's screen-projection math (`projectToScreen`, same
   formula as `interact.js`'s own `project()`) — only unit-testable
   indirectly through the pure layout functions, the actual screen
   placement needs eyes on a running scene.
3. Whether B, layered on top of V (blame card variant), R (blame card
   region — task 4), T (desk tint) and U (zoneowner) all firing from the
   same keyboard at once, reads as "one coherent set of toggles" or as
   keyboard soup. Nobody's looked at the room with all five live
   together yet.
4. Noticed but did not chase: `office.html`'s own importmap still reads
   `"three":"./vendor/three.module.js"` (resolves to
   `/src/office/vendor/three.module.js` from that document's URL, which
   doesn't exist on disk — only `web/public/vendor/three.module.js`
   does). The devtools-protocol scratchpad already documents an
   identical relative-path bug for the GLB assets that a prior round
   fixed with an absolute `/glb/...` path; this looks like the same
   class of bug still sitting in the vendor import, just never
   triggered because nobody's checked `list_console_messages` for a
   `three.module.js` 404 specifically — every browser round so far
   apparently got characters on screen, which shouldn't be possible if
   this import 404s. Not touching `office.html`'s importmap this round
   (outside this task's ownership slice and outside BROWSER: NO), and
   not filing an issue on a bug inferred from reading paths rather than
   reproduced in a browser — but the next browser slot should check
   `list_console_messages` for a `three.module.js` load failure early,
   since if it's real it would explain as a red herring any prop that
   "doesn't render" for an unrelated reason. Used a root-absolute
   `/vendor/...` path in `histshelf-test.html`'s own importmap to sidestep
   it either way.

**Tests**: `pnpm test` 182/182 passing (12 files, up from 111/9 at the
start of this round — task 2/3/4's tests landed alongside mine via
rebase). `pnpm typecheck` clean. No GitHub issues filed this round —
nothing hit that needed one; the importmap question above is flagged in
prose rather than filed, since it's unverified.

**Shared-worktree hazard worth naming for later rounds**: all four tasks
this round commit from the *same* working directory against the *same*
`.git`, not separate worktrees — so `git add`/`git commit` race on one
shared index, not just the branch tip. Caught this happening once: the
commit that carries this very STATE.md section (look for "state: log
task 1 histshelf build notes" in the log) also swept up
`web/src/office/zoneowner-test.html` and `web/test/zoneowner.test.ts` —
task 2's files, already `git add`ed by that task's own in-flight process
when my `git commit` ran a moment later, before task 2 got to their own
commit. Nothing lost or corrupted — the content is exactly what task 2
wrote, just filed under the wrong commit message and with no separate
commit of its own for those two files. Didn't rewrite history to fix the
attribution; rewriting shared branch history mid-round is worse than a
mislabeled commit. If a future round sees a file show up in an unrelated
commit, this is why — check `git log --all -- <path>` before assuming
something's missing.

## Task 2 — zone ownership flourishes (round 3)

Built the "who owns this area of the repo" flourish the brief asked for:
shortlog data rendered as physical dressing per zone, not just the text
label zones.js's `setOwner` already draws.

**New file `web/src/office/zoneowner.js`** (+`.d.ts`, +`zoneowner-test.html`
fixture harness, +`web/test/zoneowner.test.ts`, 28 tests):

- `pickOwnership(shortlogBody)` — pure, top/second author, deterministic
  tie-break (commits desc, then author name), `possessive` (>=80% share)
  and `contested` (top/second within 15%) flags.
- `hairFor(human)` / `HAIR_COLORS` — palette.ts's `hairFor` re-hosted the
  same way history-viz.js re-hosted its own hash (office/*.js can't import
  the .ts side). Six swatches copied verbatim so a human's hair colour and
  their zone plaque never disagree; a vitest case reproduces the
  multiply-by-31 hash by hand for a known string to pin the parity, not
  just assert the two happen to agree today.
- Two treatments behind key **U** (grepped office.html's keydown handlers
  first — H, T, V, Z, B were all already spoken for by the time I got to
  this, U was still open):
  - `plaque` (default) — a floating sign per zone, canvas-textured, owner
    name in their hair colour with a tinted rule, sized by
    `plaqueScale(share)`. Deliberately drawn as a warm plate rather than
    reusing zones.js's own label-pill look, so it doesn't read as the same
    "mostly X" text twice.
  - `rug` — a floor mat (CircleGeometry, inset inside the zone ring so the
    ring stays visible as a boundary) tinted by owner colour with a second
    woven stripe for the runner-up (`rugSplit`, floored at 12% so the
    stripe is always visible, capped at 45% so it never eclipses the lead).
  - Ambient extra: a small trophy prop (gold stem, owner-tinted cup) when
    one human has >=80% of a zone; two mugs side by side, one per top
    author's colour, when the top two are within 15% of each other.
    Neither renders in the "wide middle" case — most zones most of the
    time get dressing but no flourish, which is the point.
- Degrade: `pickOwnership` returns `null` on `ok:false`, an empty owners
  list (fresh dir), or a malformed body — `render()` removes and disposes
  any existing group for that zone and draws nothing. No blank plaque, no
  colourless rug.

**`web/src/office/gitsignals.js`/`.d.ts`** — extended `attachGitSignals`
with an optional `ownership: { set(zoneName, rawShortlogBody) }` sink,
called from `pollZone` alongside the existing `zones.setOwner` call, both
on a fresh fetch and on a cache hit. This is the seam the brief asked for
("extend pollZone to feed your renderer") but it is **not** actually wired
to `zoneowner.js` from `office.html` — see below for why — so today it's
tested (existing `gitsignals.test.ts`'s `zones.setOwner` assertions still
pass unchanged, since `ownership` defaults to `undefined` and the `?.`
calls no-op) but inert in the running scene. Left in on purpose as the seam
a future round should use instead of what's actually wired.

**Why `zoneowner.js` polls on its own instead**: office.html's existing
`attachGitSignals({ world, zones: zoneUI })` call lives at line ~470, deep
inside the shared file, not in this round's append-only trailing slice —
the brief's own file-ownership rule for `office.html` this round is
"append ONLY at the end... touch nothing else in that file." Editing that
call site to pass the new `ownership` sink would violate that. So
`attachZoneOwner()` runs its own self-contained shortlog poll (same
pattern `histshelf.js` already uses for its own log fetch: own cache, own
interval, no hook into the existing poller) using `gitsignals.js`'s
exported `ZONE_DIRS` for the same dir mapping so at least the zone→dir
answer has one source of truth. This is a third independent shortlog
fetcher against the same three dirs (gitsignals.js's `pollZone`, now
`zoneowner.js`'s own loop) — same "several independent, all-cheap git
fetchers, none sharing a cache" pattern this file has documented since
round 2's task 2, not new debt, but worth collapsing (route
`attachGitSignals`'s `ownership` sink into `zoneowner.setZoneOwnership`
from a single wiring call) the next time someone can touch both the
existing `attachGitSignals()` call site and the trailing fence in the same
round.

**Tests**: `pnpm test` and `pnpm typecheck` green (see the running total in
the task-1 section above — my 28 `zoneowner.test.ts` cases and the
`gitsignals.test.ts` extension are both counted in that 182/12). Hit one
flaky `gitApiMiddleware` test timeout (`blame: ignores malformed start/end`,
5s timeout) once under heavy concurrent load — a real `git` subprocess
call racing three other agents' own git/vitest/server activity in the same
repo, not a regression; reran in isolation and it passed in under a
second. Nothing to file, just naming it in case a later round sees the
same flake and wonders if it's new.

**Browser: not verified this round** (task 2 was a no-browser slot). What
to check once a browser slot picks this up: press **U** with an agent
selected/deselected doesn't matter — zone dressing isn't agent-scoped, it
should just be visible on load. Confirm plaques/rugs appear over
`desks`/`vault`/`whiteboard` (the three dirs `ZONE_DIRS` maps), the plaque
text names a real committer and the share percentage looks plausible
against `git shortlog -sn -- web/src` etc. by hand, and that toggling U a
few times in a row doesn't leak geometry (`renderer.info.memory.geometries`
before/after a dozen toggles — `disposeGroup` should keep it flat). The
fixture harness (`zoneowner-test.html`) covers the visual cases
(lopsided/trophy, near-even/mugs, clear-lead/no-flourish, solo-author,
three-way split, empty) without needing the dev server or real repo data,
so that's the fast first look if the lock is scarce.

**Not built / left as debt, on purpose**: didn't touch `dressing.js` —
the trophy/mug props live in `zoneowner.js` itself since they need a
dynamic add/remove lifecycle tied to a live poll, unlike `dressing.js`'s
build-once-at-startup furniture. Didn't add a second `attachGitSignals`
call from the wiring fence to actually exercise the new `ownership` sink
live (would mean double-polling shortlog through two different call
sites, which felt worse than one self-contained poller) — see the "why"
section above.

## Task 3 — browser slot A: verification backlog + zoom/hover motion (round 3)

### Backlog, in the priority order round 2's integrator left

1. **Both `c7e995b` fixes, confirmed live.** Called `window.__live.onPresence`
   directly with a well-formed presence frame (`{type:'presence', agent, human,
   verb, region:{path}, rung}` — the earlier note's sketch used the wrong
   field names, `id`/`path` instead of `agent`/`region.path`, so it 400'd on
   `msg.region.path` until corrected) for one agent id, then a second frame
   for the same id with a different `region.path`. `a.gitPath` followed the
   second frame's path, not the spawn-time one — the fix holds.
   For the despawn leak: dropped `director.ttlMs` to 80ms, spawned and let
   six different agent ids expire one at a time via the real `tick()` loop
   (not a manual despawn call — this exercises `expireLive` exactly as a live
   session would), and read `renderer.info.memory.geometries` after each
   cycle. Flat at 97 across all six. No creep.
2. **Round-2 features together in one scene**, agent-2 selected
   (`cpp/hook/hook.cpp`, the flagged busy file): got one clean screenshot with
   the region-blame panel (task 4's work, landed since the last STATE.md
   revision — "WHOSE LINES THESE ARE" toggle, ownership bar at 100%
   mohsensc, commit dot timeline) rendered together with the click-to-zoom
   flight and the corner hover/click panel. Did not get a clean second
   screenshot with T's breathe mode and V's classic variant layered on top
   before losing the tab to port contention (see below) — the steady/graphic
   combo is confirmed rendering correctly and not fighting with the region
   panel, which was the open question.
3. **Churn typing-speed / paper-stack visuals**: not verified. Lost the
   browser slot (below) before getting to this one. Still open for whoever
   gets the next slot — `agent2`/`cpp/hook/hook.cpp` is still the strongest
   real signal per round 2's own note.
4. **Console sweep**: clean both times the page loaded successfully. Only
   the two expected lines — `coffee-cup-v2.glb` 404 (issue #59) and the relay
   `ECONNREFUSED` in demo mode. No new errors from this round's changes.

### Port contention this round, worse than the protocol anticipates

Filed **issue #61**. Short version: featB (`sync-featB`, `feat/highlight-reel`)
had their own vite bound to 5173 *while I held the lock*, twice in one
session — I'd steal a stale lock, start my server, confirm via curl it was
serving my worktree's `office.html`, run one or two checks successfully,
and a few calls later `evaluate_script` would come back with featB's DOM
(`.reel-item`/`.reel-chip` elements, `reel.js`/`seed.js` in the network
log) because their `--strictPort` vite had bound 5173 out from under mine
mid-session. `lsof -i :5173` confirmed their process both times. Neither
side's server appears to check the lock file before binding — the lock
only serializes agents that actually watch it, and killing/restarting
doesn't fix a race where the other side restarts a beat later. Cost real
time — most of a browser slot went into re-fighting for the port rather
than testing. Backlog items above are as far as I got before giving up on
further live verification per this round.

### Zoom and hover motion — built, typechecked, one live check

**Camera flight (`web/src/office/office.html`)**: `zoomToAgent`/`zoomRestore`
used to ride the same per-frame exponential-decay `goal.active` lerp as every
other camera move in the file — smooth, but shapeless, a dolly rather than a
look. Replaced just those two call sites with a `flight` object that has an
actual start, end and duration, so it can carry a shape the continuous decay
never could:

- **`ease`** (default) — ease-in-out cubic over ~0.92s, with a lateral arc:
  the flight path bows sideways off the straight line between old and new
  camera target, peaking at the midpoint and returning to zero at both ends
  (`Math.sin(Math.PI * p)`), so a head zoom reads as leaning in to look
  rather than a rig sliding on a rail.
- **`snap`** — ease-out-back over ~0.42s, so the camera overshoots the
  final framing slightly and settles back — a flinch-and-focus instead of a
  glide. No lateral arc; the overshoot itself is the character here.

**Z** toggles which one the *next* flight uses (deliberately doesn't retarget
a flight already in progress — switching mid-zoom shouldn't jump). `focus()`/
`goal` is untouched and still drives every other camera move in the file
(demo.js's scripted shots, the top-down/auto-rotate buttons) — this is
additive, not a rewrite of the camera system. Manual camera input (drag,
wheel) cancels an in-progress flight the same way it already cancelled
`goal.active`. Exposed `window.__zoomMode` (`get`/`set`/`flying`) for
scripted checks.

**Hover treatments (`web/src/office/interact.js`)**: three now, cycled with
**H**:

- **`card`** (default, unchanged) — the existing corner card, doing/zone/file
  plus the two git rows that fade in once their fetches resolve.
- **`nameplate`** — stripped down to just name + role, floating in 3D over
  the character's head (projected from world space every frame via the
  existing `pulseHover` rAF loop, not pinned to the cursor like the other
  two) — for when the corner card is more chrome than the moment needs.
- **`rich`** — the same card, but the ownership line ("code is N% theirs")
  moves up to sit right under the role, ahead of doing/zone/file, via CSS
  `order` on a flex column rather than restructuring the DOM insertion order
  — the row still lands async off `host.after(row)` exactly like before, CSS
  just repositions it. For when whose-code-is-this is the thing worth
  reading first.

Exposed `interaction.hoverTreatment` (getter) and `setHoverTreatment(mode)`
for scripted checks.

**Live verification**: got one clean screenshot of the eased zoom flight
completing correctly (agent-2, head-framed, `window.__zoomMode.flying` false
after settle, no console errors) before the first port-contention loss.
Did **not** get clean screenshots of `snap` mode or any of the three hover
treatments — every attempt after the first lost the tab to featB's server
mid-check (see above). Code is typechecked and exercised by hand via
`evaluate_script` (confirmed `hoverTreatment` cycles and `HOVER_TREATMENTS`
order is right), just not eyeballed as pixels. Next browser slot on this
branch: press **H** three times with an agent hovered and screenshot each,
press **Z** once and zoom a second agent to see the overshoot-settle, both
fast checks once the port stops changing hands mid-session.

### Tests / typecheck

`pnpm test` — 182/182 passing, 12 files (includes tasks 1/2/4's new test
files, landed via `git pull --rebase` through this session — this round's
own changes added no new test file, `interact.js`'s `ownershipShare` export
is unchanged). `pnpm typecheck` — clean. Hit one flaky `gitApiMiddleware`
timeout under heavy concurrent load (four agents' worth of `git`/vitest/vite
all hitting the same repo at once) — reran in isolation, passed in under a
second. Not a regression, just naming it in case a later round sees the
same flake.

### Files touched this round

`web/src/office/office.html` (camera flight, Z toggle, `window.__zoomMode`
test hook — touched outside task 1/2's trailing wiring fences per the
boundary), `web/src/office/interact.js` (hover treatments, H toggle, CSS for
`nameplate`/`rich`). No new files. `interact.d.ts` untouched — no new
exported pure function this round, `ownershipShare`'s signature didn't
change.

## Round 3 task 4 (browser slot B) — region blame end to end

The seed idea's actual core: not "what file is this agent touching" but
"which lines does it hold, right now, and whose work is under it." Wired
the whole pipe demo → blame card, and as far into live → blame card as the
file-ownership boundary this round drew would allow.

### What's built

**`web/src/office/demo.js`** — a `REGIONS` map (`a2` → `cpp/hook/hook.cpp`
120-150, `a3` → `web/src/office/anim.js` 200-230, `a4` →
`go/cmd/gorelay/main.go` 15-40), stamped onto `.gitStart`/`.gitEnd` on the
live `agents` array objects at the top of `script()` — same instances
office.html already assigned `.gitPath` to, so this never duplicates or
overrides the path, just adds the range. Deliberately left two cast members
without a range: `a1`'s file
(`python/src/agent_presence/__init__.py`) is a genuinely empty stub — zero
lines, `git blame` returns nothing — so selecting it exercises the "no
history at all" fallback for real rather than a faked one; `a5`
(`README.md`) stays whole-file-only on purpose so there's always at least
one demo agent to compare the region view against the plain ownership bar
without needing the toggle. All three ranges verified against real `wc -l`
output while writing this (813/1094/100 lines respectively) and picked well
inside each file, per the round plan's own drift warning. If a future
change to those files ever pushes a range past EOF, nothing breaks —
gitapi.mjs's blame route already returns `{ok:false}` for a bogus range,
and blamecard.js's fallback (below) treats that exactly like "no history",
never an empty box. Didn't file an issue for this; the endpoint's own
design already covers it, so there was nothing left to flag.

**`web/src/office/live.js`** — `regionFromMsg(msg)`, a pure guard that
pulls `region.start`/`region.end` off a presence frame and returns
`{start, end}` only when both are finite and `end > start`; anything else
(absent, partial, malformed, inverted) reads as `null`, same as no region
at all. `LiveDirector.onPresence` now folds this into its per-agent
`records` (adds a `region` field) and returns `start`/`end` on the info
object it hands back — `null` when there's no usable range, so a consumer
that never reads those two fields sees zero behavioural change. Exported
and typed in `live.d.ts`.

**Known gap, not silently dropped: the live → `Agent` hop.**
office.html's `onLivePresence` still only does `a.gitPath = info.path`; it
never reads the two new fields `LiveDirector` now returns. Wiring that up
is a genuine one-line follow-up (`a.gitStart = info.start; a.gitEnd =
info.end` right next to the existing `gitPath` line) but `office.html` was
explicitly off-limits to this task this round — the same shape of problem
round 2 task 2 hit with the `gitPath`-staleness bug, which round 3's
integrator fixed once it owned the whole tree. Flagging it here the same
way so whoever next has `office.html` open doesn't have to rediscover it.
Everything on the live.js side is unit-tested and ready; only that one
line in office.html is missing. Demo mode, which does not go through
`onLivePresence` at all, is unaffected and fully wired — see the browser
verification below.

**`web/src/office/blamecard.js`** — the actual feature. New exports,
pure and covered directly by `web/test/region-blame.test.ts`:
`hasUsableRegion(agent)` (does this agent carry a real path + well-formed
range), `regionBlameUsable(regionBlame)` (did the ranged endpoint actually
find lines there — the fallback gate), `regionGutterSegments(blame,
agent)` (the `owners` aggregate turned into sorted, rounded, self-tagged
segments), `regionSummary(blame)` (the "these N lines: mostly X, newest Yh
ago" line, `null` when there's nothing to summarise). `show(agent)` now
fetches ranged blame alongside the existing whole-file blame+log when
`hasUsableRegion` is true, in parallel, with its own cache
(`path#start-end` key) separate from the whole-file one so re-selecting or
toggling never refetches either. Defaults to the region view when one is
usable, falls back to the whole-file ownership bar silently when it isn't
(bogus range, 0-line result, or no range declared at all — three different
inputs, one fallback path). New key: **R** toggles region ↔ whole-file when
an agent has both (button in the card does the same thing, same pattern as
the existing V/graphic-classic toggle); the button and the R handler are
both scoped to blamecard.js's own listener, so they never touch
office.html or interact.js's key bindings. Checked the full grep of
`addEventListener('keydown'` across office/*.js before picking R — clear.

**Honest limitation, documented rather than papered over:** the region
strip is a proportional colour gutter (segments sized by author share),
*not* literal per-line source text with a real editor-style gutter next to
each line. `parseBlamePorcelain` (gitapi.mjs, not owned this round)
collapses straight to `{total, owners: [{author, lines, share}], ...}` —
it never returns per-line author or the actual line content, by design
(that's the "reuse the output shape as-is" constraint the round plan set).
So "these 14 lines: mostly mohsensc, newest 2h ago" is real and accurate;
a literal blamed-code view with real text per line would need
`parseBlamePorcelain` to keep per-line data instead of aggregating, which
is a `gitapi.mjs` change and genuinely out of this round's file-ownership
scope. Not filing an issue for this — it's a known, deliberate trade-off
inside the constraint the plan itself set, not a bug or an oversight.

**`web/src/office/blamecard-test.html`** — two new fixtures, `region`
(14 lines, mixed 11/3 split, fresh) and `regionFallback` (a range past EOF,
`regionBlame: {ok:false}`, exercises the silent fallback). `stubFetch` now
branches on whether the blame request carries a `start` param. `show()`
stamps `gitStart`/`gitEnd` from the fixture's `range` onto the fake agent
when present.

**`web/src/office/blamecard.d.ts`** — new file (blamecard.js had none
before this round). Types the pure region exports plus the existing
`attachBlameCard` shape loosely, same pattern as `live.d.ts`/
`histshelf.d.ts` — needed once `region-blame.test.ts` imported a `.js`
file typecheck couldn't otherwise see into.

**`web/test/region-blame.test.ts`** — new, 27 tests: `regionFromMsg`'s
guard logic (well-formed, absent, partial, inverted, non-finite, no region
object at all), `LiveDirector.onPresence` carrying start/end through per
agent without cross-contamination between two different agents' frames,
`hasUsableRegion`/`regionBlameUsable`'s fallback gates, `regionGutterSegments`
(ordering, rounding, self-tagging, empty-on-unusable), `regionSummary`
(top author/share/age formatting across day/month/year buckets,
multi-vs-single-author, null-on-unusable).

### Browser verification — done, not skipped

Got the lock (~15s wait, `builder3-featA-zoomhover2` had just released it),
started the dev server from this worktree, hit the known first-attempt
snag (backgrounding the vite process with a bare `&` inside one Bash call
got it reaped when that call returned — restarted with `nohup … & disown`
and it stayed up for the rest of the session), reused the existing tab
(page 6), never opened a second one.

Checked, in demo mode (`?demo=1` default — relay unreachable banner, as
expected):
- `window.__cast` confirms all three regioned agents carry real
  `gitStart`/`gitEnd` (`a2` 120-150, `a3` 200-230, `a4` 15-40) and the
  other two don't.
- Selected `a2` (`cpp/hook/hook.cpp`): card opens straight into the region
  view — `cpp/hook/hook.cpp : lines 120–150`, `these 31 lines: mohsensc,
  newest 5 days old`, a solid single-author gutter bar, an R-labelled
  toggle button reading "this region". Pressed R (dispatched a real
  `keydown`) — flipped to `whole file`, path label dropped the range
  suffix, ownership bar re-rendered with the whole-file numbers (`newest
  line 2d old · oldest line 5d old` — genuinely different from the
  region's `5 days old`, which is the whole point). Toggled back, clean.
- Selected `a1` (`python/src/agent_presence/__init__.py`, no region, empty
  file): card shows `no history here yet`, no region toggle button at all
  — confirms `hasUsableRegion` correctly reads "no range" and
  `regionBlameUsable` never gets a chance to matter here since the
  whole-file blame is empty too. No empty box, no crash.
- Selected `a3` (`web/src/office/anim.js`, 200-230): same shape as `a2`,
  `these 31 lines: mohsensc, newest 1 day old` — real, different numbers
  from `a2`, confirming this isn't a cached/stale render.
- Selected `a5` (`README.md`, no region, real whole-file history): only
  the graphic/classic variant button shows, no region toggle — confirms
  the toggle only appears when a region actually exists, not just when
  blame data exists.
- `list_console_messages` (error+warn): exactly the two known
  pre-existing ones — `coffee-cup-v2.glb` 404 (issue #59, not this
  branch's to fix) and the demo-mode relay `ECONNREFUSED`. Nothing new
  from this round's work.

Screenshots taken at each step (not saved to disk, reviewed inline).
Didn't test the live-mode path in the browser since there is no relay
running in this environment and, per the known gap above, office.html
doesn't forward `info.start`/`info.end` onto the agent yet anyway — that
half of the pipe is unit-tested only, honestly reflected as such rather
than claimed as browser-verified.

Killed the server (`pkill -f 'vite.*5173'`) and released the lock
immediately after.

### Tests / typecheck

`pnpm test` — 182/182 passing, 12 files (picked up task 1's `histshelf`
and task 2's `zoneowner` test files mid-session via the shared worktree,
nothing broken by either). `pnpm typecheck` — clean.

### A note on the shared worktree

All four of this round's tasks ran in the *same* physical directory
(`sync-featA`), not isolated worktrees per task, despite the per-task
briefs saying "your worktree" individually — meaning a shared git index as
well as a shared filesystem. Caught this the hard way: an early `git add
web/src/office/live.js` staged my change, and a concurrent agent's next
`git commit` (for an unrelated zone-ownership feature) swept my staged
`live.js`/`live.d.ts` changes into *their* commit
(`2a8910b add zone-ownership sink to gitsignals pollZone`) before I could
commit it myself under its own message. The content is correct and safely
on `origin/feat/git-aware-characters` either way — verified via `git diff
<before> HEAD -- live.js` coming back empty — but the commit message
doesn't describe what it contains. Not fixable after the fact without
rewriting shared history mid-round, so leaving it as-is and flagging it:
if a future round needs `git blame` on `live.js`'s `regionFromMsg`
addition, look in `2a8910b`, not a commit that mentions region blame.
Lesson for later rounds sharing this worktree: commit fast after staging,
or use `git commit <pathspec>` without a prior `git add` at all (which is
what every commit after this one in this session did) — it stages and
commits only the named paths in one atomic step, closing the window
entirely.

### What's next

- The office.html one-liner above (`a.gitStart = info.start; a.gitEnd =
  info.end` in `onLivePresence`) — small, ready, blocked only on file
  ownership.
- True per-line region rendering (real source text + real per-line
  gutter) would need `parseBlamePorcelain` to keep per-line author instead
  of collapsing to aggregate totals — a `gitapi.mjs` change, deliberately
  out of scope this round.
- Nothing filed as a GitHub issue this round — every edge case
  (empty file, bogus range, no region at all) already degrades through
  existing, tested fallback paths; there was nothing left over that
  needed a ticket instead of a fix.
