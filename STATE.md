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
