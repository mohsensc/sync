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
