# STATE — feat/git-aware-characters

Round 4 starts here. This is an integrator pass over round 3's four parallel
builders (file-history bookshelf, zone-ownership dressing, zoom/hover motion
+ verification backlog, region blame end-to-end). Read this before touching
anything — round 4 has no memory except this file. Trimmed round 3's
builder-by-builder play-by-play out of here; PR history and `git log` still
have it if you need the detail (commits `3232a1c`..`5a77431` cover round 3).

## Where things stand

Branch is coherent, everything from round 3 is merged in and pushed.
`pnpm test` — 182/182, 12 files. `pnpm typecheck` — clean. Both verified
fresh at the end of this round, after this round's own fixes.

Checked for four-way-concurrent damage and found none new:
- No conflict markers, all `office/*.js` + the extracted `office.html`
  module script parse clean.
- No duplicate helpers: `histshelf.js` correctly imports `colorForAuthor`/
  `hueForAuthor` from `history-viz.js` rather than reimplementing the hash;
  `zoneowner.js`'s `hairFor`/`HAIR_COLORS` is a deliberate, documented
  re-host of `palette.ts` (office/*.js can't import the .ts side), not an
  accidental duplicate. `ZONE_DIRS` has one definition (`gitsignals.js`),
  imported everywhere else that needs it.
- No unused imports (checked every `office/*.js` import list against its own
  body).
- Key bindings: B (histshelf) / H (hover treatment) / R (blame region) / T
  (desk tint) / U (zone ownership) / V (blame variant) / Z (zoom mode) /
  Escape — eight single-owner keys, no collisions. Round 3's own
  histshelf-vs-hover H collision was already caught and fixed mid-round
  (moved to B) before it landed.

## Two things fixed this round, found by actually reading the code + browser

1. **office.html's one-line gap, closed.** Round 3 task 4 built the full
   live→region pipe (`live.js`'s `regionFromMsg`, `LiveDirector.onPresence`
   returning `start`/`end`) but couldn't wire the last hop
   (`onLivePresence` → `a.gitStart`/`a.gitEnd`) because `office.html` was
   off-limits to that task. Fixed: `a.gitStart = info.start; a.gitEnd =
   info.end` right after the existing `a.gitPath = info.path` line. Live-mode
   region blame is now fully wired, not just demo-mode. (`c387597`)

2. **Real browser bug: zone-ownership plaques ballooned to fill the screen
   during the new zoom flight.** Round 3 shipped two features that never got
   tested together: `zoneowner.js`'s plaque/rug (task 2, on by default) is a
   fixed-world-size `THREE.Sprite`/mesh, and the new head-zoom camera flight
   (task 3, `Z` toggle) parks the camera a couple of metres from an agent's
   desk when you select them. Up close, a sprite sized for the normal wide
   room shot fills most of the frame and visually bleeds through the
   semi-transparent blame card / hover panel sitting on top of it in the DOM.
   Reproduced live: selecting `a2` and letting the zoom flight settle put the
   "desks" plaque's giant `mohsensc` text across half the screen, overlapping
   the region-blame card. Fixed by adding `updateCamera(camera)` to
   `attachZoneOwner`'s return value — each frame it fades the zone prop's
   opacity out as camera distance drops below 3m (fully hidden) up to 5.5m
   (fully shown), instead of capping world scale. Wired into `office.html`'s
   `tick()`. Verified live: zoomed close on `a2`, plaque fades cleanly, blame
   card fully readable; zoomed back out, plaque returns. (`09b6ca3`)

Both fixes typechecked clean and kept `pnpm test` at 182/182 (no new test —
neither is unit-testable without a live camera/THREE scene; both were
caught and confirmed by eyes-on-screen, which is exactly why this round's
integrator browser pass mattered).

## Also resolved: task 1's importmap suspicion was a false alarm

Round 3 task 1 flagged, from reading paths only, that `office.html`'s
`<script type="importmap">` (`"three":"./vendor/three.module.js"`) looks
like it should 404 the same way the GLB assets used to — `./vendor/...`
resolves relative to the document URL (`/src/office/office.html`) to
`/src/office/vendor/three.module.js`, which doesn't exist on disk (only
`web/public/vendor/three.module.js` does, served at `/vendor/...`).

Checked live this round via `list_network_requests`: the browser never
actually fetches that importmap URL at all. Vite's dev server rewrites bare
`three`/`three/addons/...` specifiers inside every `<script type="module">`
it transforms to point at its own optimized-deps cache
(`/node_modules/.vite/deps/three.js`, from the `three` entry in
`package.json`'s `dependencies`), which happens *before* the browser's
native import-map resolution would ever run. The importmap is dead code in
`pnpm dev` — not exercised, not a bug in the mode this scene actually runs
in (README already says `office.html` needs `pnpm dev` and a browser; there
is no separate production build path for it). Leaving the importmap as-is;
not worth touching a working (if redundant) declaration. Not filed as an
issue — confirmed non-issue, not a deferred one.

## Browser verification: done, and it's why the round-3 bug above got caught

Took the lock (`~12 min wait`, `featB-round5-integrator` held it), started
this worktree's server, confirmed via `curl` + `list_network_requests` it
was serving my worktree's files before touching the tab.

**Mid-session, lost the lock and the server anyway** — a concurrent
process's own release step (`pkill -f 'vite.*5173'; rm -rf $LOCK`, the exact
protocol release command) fired while I still held it, killing my server and
freeing the lock out from under me. Re-acquired within ~30s (nobody else
grabbed it in that window this time) and continued. This is the same shape
of problem issue #61 already documents (featB's server repeatedly stealing
5173 mid-session) — not filing a duplicate, but noting I hit it personally
this round, from the other side (my session got killed, not stolen-from).
The lock has no compare-and-swap on release; any agent's routine cleanup can
tear down another agent's active session. Worth a protocol fix if this
keeps costing rounds real time — out of scope for this round to fix (it's
the scratchpad protocol doc, not this branch), flagging for whoever owns
that file.

**Confirmed working, live, this round:**
- Base scene: 15/15 objects loaded, characters/desks/props all render,
  console clean apart from the two known pre-existing lines (`glb` 404 issue
  #59, demo-mode `ECONNREFUSED`).
- Region blame (`R` toggle, task 4): selected `a2`
  (`cpp/hook/hook.cpp`, lines 120-150) — card opens straight into the region
  view, real gutter/summary (`these 31 lines: mohsensc, newest 5 days old`),
  `R` flips to whole-file and back cleanly.
- Live-mode region forwarding (this round's fix #1): `window.__cast` shows
  `a2`/`a3`/`a4` all carry real `gitStart`/`gitEnd` in demo mode already;
  the office.html hop is the piece that made this reach live mode too,
  unverified against a real relay in this environment (none running here —
  same limitation task 4 had).
- Histshelf (`B` toggle, task 1): confirmed both treatments render with
  real data — DOM strip (`#hshelf`, 10 real commit spines with
  author/message/age tooltips, gold-tinted) and 3D spines
  (`histshelf-root` group in-scene, visible as a small staircase of colored
  bars near the agent).
- Zone ownership (`U` toggle, task 2): both plaque and rug render with real
  shortlog data (`mohsensc 100%`/`86%` etc.), trophy/rug-stripe flourishes
  visible. This is also where the zoom-overlap bug above was found and
  fixed.
- Hover treatments (`H`, task 3): confirmed `hoverTreatment`/
  `setHoverTreatment('nameplate')` work via `evaluate_script` — not
  screenshotted as pixels for `nameplate`/`rich` specifically (ran out of
  lock time after the plaque-fade fix and re-verification). `card` (default)
  already gets exercised implicitly by every other screenshot in this round.
- Camera flight (`Z`, task 3): `ease` mode (default) confirmed smooth and
  settling correctly (`window.__zoomMode.flying` false after landing,
  matches task 3's own finding). `snap` mode still not re-verified visually
  this round either — same gap task 3 left, still open.

**Not reached this round:** churn typing-speed/paper-stack visuals — still
unverified going back two rounds now (flagged by round 3 task 3, and round 2
before that). No test in this repo instantiates a real `Agent`, so this
needs a live look specifically, on a busy agent (`agent2`/`cpp/hook/hook.cpp`
is still the flagged strongest signal). Worth a dedicated slot.

Killed the server, released the lock, confirmed port free before finishing.

## What's NOT built yet / still genuinely open

- **Churn visuals unverified in browser**, three rounds running now (see
  above). Next round with a spare browser slot: select `agent2`, watch
  typing speed and the paper-stack prop for a beat or two, screenshot it.
- **`Z` snap mode and `H`'s `nameplate`/`rich` treatments**: code is real,
  typechecked, exercised via `evaluate_script`, never screenshotted as
  pixels. Quick check: `window.__interact.setHoverTreatment('nameplate')`
  then hover a character; `window.__zoomMode.set('snap')` then
  `window.__zoomAgent('a3')` and watch for the overshoot-and-settle.
- **Symbol-level blame beyond a line range**: `gitapi.mjs`'s `blame` route
  has taken `start`/`end` since round 2; a `Region` on the presence protocol
  has carried them since round 3 task 4. Endpoint-ready, protocol-ready,
  rendered in the demo cast and (as of this round) forwarded in live mode
  too. What's left is genuinely upstream of this branch — nothing more to
  do here until the C++ hook/Go relay side actually populates
  `region.start`/`region.end` on real presence frames.
- **True per-line region rendering** (real source text + a real editor-style
  gutter, not a proportional colour bar) needs `parseBlamePorcelain` in
  `gitapi.mjs` to keep per-line author data instead of collapsing to
  aggregate `{total, owners}`. Deliberately out of scope for the
  office-side rounds so far — a `gitapi.mjs` change.
- **Three independent client-side git-data fetchers**, no shared cache
  (`interact.js`'s hover card, `gitsignals.js`'s ambient poll,
  `blamecard.js`'s own blame fetch, and now `histshelf.js`/`zoneowner.js`
  each running a fourth and fifth). All cheap, all local, all degrade fine
  independently — documented every round since round 2, still not worth a
  standalone task. Collapse it opportunistically if a future round is
  already touching two or more of these files.

## Nothing filed as a GitHub issue this round

Both real bugs found (the live.js one-liner, the plaque zoom-overlap) were
small enough to fix inline in the time it took to characterize them — no
issue needed. The importmap concern from round 3 turned out to be a false
alarm, not a deferred bug. Issues #59 (`coffee-cup-v2.glb` 404) and #61
(shared-port contention) remain open from prior rounds; #61 nearly got a
duplicate filed against it this round for the lock-loss described above
before double-checking it's the same root cause already on file.

## Browser/port discipline

Followed the protocol: reused the existing tab (never opened a second),
served from this worktree only, verified via network trace before trusting
what was on screen (worth doing given #61 — a stale tab can silently be
showing a different worktree's server). Killed the server and released the
lock at the end, confirmed the port was actually free before finishing
rather than trusting `pkill` on faith (`npx vite` spawns a child process
that a plain `pkill -f 'vite.*5173'` didn't always catch this round — killed
by port with `lsof -ti :5173 | xargs kill -9` instead when that happened).
