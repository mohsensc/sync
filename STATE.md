# STATE — feat/git-aware-characters

Round 2 (integrator pass over round 1's four parallel builders). Read this
before touching anything — round 3 has no memory except this file.

## Where things stand

The branch is coherent. Four builders landed concurrently in round 1 (git
data endpoints, hover card, click-to-zoom + blame card, freshness halos +
zone ownership) and it merged cleanly — no conflict markers, no duplicate
helpers doing the same job under different names, no dead imports. Field
names line up end to end (`gitapi.mjs`'s `lastAgeDays`/`lastAuthor`/`owners`
etc. are read correctly by `interact.js`, `blamecard.js`, `gitsignals.js`).
`onLivePresence` correctly threads `info.path` into `spawnLive`, so live
agents get `gitPath` same as the demo cast.

`pnpm test` and `pnpm typecheck` — the actual commands from the brief, not
workarounds — both run clean now: 72/72 tests, 6 files, tsc clean. Builder
2's `pnpm-workspace.yaml` fix (`allowBuilds: { esbuild: true }`) resolved
the `ERR_PNPM_IGNORED_BUILDS` preflight failure every builder hit and worked
around individually last round. Nobody needs to route around `pnpm test`
anymore — use it directly.

## Verified live in the browser, all real data, no mocking

Took the lock, ran vite from this worktree, drove the existing `window.__*`
test hooks (`__interact.project`/`.hoverAt`, `__zoomAgent`) since the canvas
scene has no per-agent DOM node to click through devtools directly.

- **Zone ownership nameplates** (task 4) — visible on room load, no
  interaction needed. "desks — ordinary edits · mostly mohsensc", "vault —
  auth and secrets · mostly mohsensc", "whiteboard — planning · mostly
  mohsensc" all rendered with real `git shortlog` data on the existing zone
  label pills.
- **Hover card** (task 2) — confirmed via `#it`'s actual innerHTML after
  hovering agent-4 (`go/cmd/gorelay/main.go`): `"last touched 1d ago by
  mohsensc · 2 commits · 1 author"`, tagged `.git.fresh` correctly (real
  `ageDays` < 2).
- **Freshness halos** (task 4) — confirmed via `agent._freshness` +
  `agent.freshHalo.material.opacity` on all five demo-cast agents post-poll:
  real buckets (`warm`/`fresh`), nonzero opacity. Visually the halo reads as
  a second, subtler ring alongside the tone halo — matches what builder 4
  described wanting checked; it does read as distinct, not muddy.
- **Click-to-zoom + blame card** (task 3) — `__zoomAgent('a3')` eased the
  camera into agent-3's head and slid in the blame card: real ownership
  (100% mohsensc), real newest/oldest line ages, eight real recent commits
  with sha/relative-date/subject/author for `web/src/office/anim.js`.
  `Escape` closed the card and restored the room framing cleanly, confirmed
  by screenshot both before and after.
- **Console**: only two messages throughout, both pre-existing and already
  understood — `coffee-cup-v2.glb` 404 (asset file genuinely missing from
  `public/glb/`, cosmetic, one missing prop) and the relay websocket
  `ECONNREFUSED` (expected — no relay running, demo fallback is the
  designed-for path and it kicks in correctly). No errors caused by any of
  this round's code.

## What I fixed this round

**Blame card overlapped the HUD panel.** `blamecard.js`'s `#bc` was
`position:fixed; left:18px; top:50%; transform:translate(-16px,-50%)`, and
`office.html`'s `#hud` is `position:fixed; left:18px; top:16px`. Both anchor
the same corner. The blame card's content (ownership bars + up to 8 commits)
routinely runs taller than half the viewport, so its top edge crept up into
the HUD's space — "Restart demo"/"Zones" buttons showed through underneath
the card's header, screenshot-confirmed before the fix. Changed `#bc` to
`top:328px; bottom:16px` (clears the HUD's actual height) with a
horizontal-only slide transform instead of vertical-centered. Re-verified in
browser: full HUD and blame card both fully legible with no overlap, same
`__zoomAgent('a3')` repro. One-line-comment in the CSS explaining the 328px
number so nobody has to redo the math if the HUD's content changes size.

Nothing else needed a code fix this round — the four builders' integration
was clean going in.

## Things noticed but NOT changed (logged so nobody re-investigates blind)

- **Two independent `/api/git/stat` pollers.** `interact.js`'s hover card
  fetches+caches `/api/git/stat` itself (30s TTL, per-hover), and
  `gitsignals.js` also polls `/api/git/stat` for every agent with a
  `gitPath` (20s interval, ambient). They don't share a cache, so hovering
  an agent can trigger a `git log` process spawn even though gitsignals
  already has a fresh answer for the same path within its own TTL. Not a
  bug — git log against a small repo is cheap and both endpoints degrade
  fine — just a small redundancy. Worth collapsing into one shared cache
  if a future round touches either file, not worth a standalone task.
- **`fmtAge` (interact.js) vs `freshnessBucket` (agent.js) are two separate
  functions**, not accidental duplication — one formats a display string
  ("1d ago"), the other buckets a halo color/radius. Different jobs, kept
  separate on purpose, flagging only because they look similar at a glance.
- **Character torsos look bare/skin-toned from some camera angles**,
  noticed while screenshotting the "beat 3/6" demo state (agents seated at
  desks, viewed mostly from behind). Could not confirm this is a real
  regression versus just how the clay-shirt texture reads at that camera
  distance/lighting — `dressing.js` and the shirt/skin material setup in
  `makeCharacterRoot` weren't touched by any of round 1's four builders, so
  if it's real it predates this branch's work. Didn't chase it — out of
  scope for git-aware characters specifically. Next round: if you're in
  office.html anyway, look at a seated agent from behind at close range and
  see if it's actually bare skin or just how the shirt fabric reads; file
  an issue if it's real.

## What's still half-built / open from round 1, unchanged by me

- **Live-mode `gitPath` only sets once at spawn.** If a live agent moves to
  a different file mid-session, the hover card / freshness halo / blame
  card all keep showing the file it *arrived* on, not the current one.
  Doesn't break anything (matches "recent enough to be true," not
  "literally millisecond-fresh"), but worth fixing if round 3 has slack:
  `onLivePresence` already has `info.path` on every frame — just needs to
  write `a.gitPath = info.path` there instead of only in `spawnLive`.
- **Zoom-during-a-walk-animation** still unverified (flagged twice now,
  by builder 3 and not re-tested by me — the demo cast was mid-walk during
  some of my zoom tests and it looked fine, camera eased to wherever the
  agent's root was at the time, no visible glitch, but I didn't specifically
  chase a walk-cycle mid-stride the way a dedicated test would). Downgrading
  this from "worth an eyeball" to "probably fine, low priority" based on
  what I saw, but not calling it fully verified.
- **`FRESH.normal`'s 0.16 opacity** (builder 4's flag, agent.js) — not
  re-checked this round; the repo's only 6-7 days old so nothing hits the
  `normal` bucket yet to look at (same "nothing stale yet" gap noted last
  round, still true).

## What's NOT built yet (untouched territory, still open per original plan)

- Whose-code-is-this desk/prop tinting (blame ownership fraction blended
  onto desk materials) — machinery for it exists (`interact.js`'s
  `tint()`/`ownMaterials()`, already used for desks) but nobody's wired
  blame data into it yet.
- Symbol-level blame (blame pinned to the specific function/symbol a
  presence frame names, not just the whole file) — the presence protocol
  gap noted in round 1's STATE (no line range in `Region`) is still there.
  File-level is what's built and it's honest about being file-level; a
  symbol-grep heuristic is still an open idea, not started.
- Diffstat / "how much did this just change" ambient signal — sketched in
  round 1's plan, no endpoint or UI for it yet.

## Nothing filed as a GitHub issue this round

Nothing hit that needed one — the one real bug found (blame card / HUD
overlap) was cheap enough to fix inline rather than defer.

## Browser/port discipline

Lock was held by another process (`builder3-shove`, presumably a leftover
from round 1, well under the 12-minute steal threshold) when I started —
waited it out rather than stealing it early. Took it once free, ran vite
from this worktree on 5173, drove the existing tab (id 6, "Agent Presence —
the office"), killed the server and released the lock when done. Same
protocol file as before, nothing about it changed this round.
