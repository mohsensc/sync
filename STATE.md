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

## round 2 task 1 — churn endpoint and blame line ranges

Server-seam work, no browser needed. Extended `web/gitapi.mjs`:

- **`GET /api/git/churn?path=`** — new route. Runs `git log --since=14.days
  --numstat --format=%H` (recent commits touching the path) and `git diff
  --numstat HEAD` (uncommitted churn) in parallel, sums added/deleted from
  the numstat rows, counts commits from the sha lines. Binary files print
  `-` for added/deleted in numstat output — treated as 0, checked against
  real git output before writing the parser rather than guessed at. Response
  shape matches the contract task 2 needed: `{ ok: true, recent: {commits,
  added, deleted, windowDays: 14}, working: {added, deleted} }`. Verified
  with a real call against `web/src/office/office.html` (edited a lot this
  week): `{"recent":{"commits":9,"added":1101,"deleted":237,"windowDays":14},
  "working":{"added":0,"deleted":0}}` — real, nonzero.
- **`blame` route** now accepts optional `start`/`end` query params, clamped
  to `1..500000`, passed as `['-L', 'start,end']` to `git blame --porcelain`
  when both parse as plain non-negative integers. Malformed or partial
  input (one present, one missing, non-numeric, negative, decimal) is
  ignored entirely rather than half-applied — falls back to whole-file
  blame, same as no range param at all. Unblocks symbol-level blame for a
  later round; nothing calls it with a range yet since the presence
  protocol still doesn't carry a line range.
- New pure parsers: `parseChurnLog`, `parseNumstat`, `blameRangeArgs` — same
  house pattern as `parseStatLog` etc., no process-spawning, unit tested
  with canned text shaped after real git output.

Files touched: `web/gitapi.mjs`, `web/gitapi.d.mts`, `web/test/gitapi.test.ts`.
Nothing under `web/src/office/` touched.

Verified: `pnpm test` and `pnpm typecheck` both clean at commit time.
`pnpm typecheck` failed once later in the same session on
`test/history-viz.test.ts` (task 3's file, missing a `.d.ts` for
`history-viz.js`) — not mine, flagging so it's not missed before merge.

Worth noting for whoever reads this: this worktree is shared live across
all four round-2 builders on the same filesystem, not isolated per-agent.
`git pull --rebase` failed mid-task on unstaged changes that turned out to
be another builder's in-progress files, updated on disk between edits.
Stashed only my own files by explicit pathspec (never a bare `git stash`),
rebased cleanly, and dropped the other stash without applying it once
diffing showed the on-disk copy was newer than what I'd captured. Also: a
first attempt at appending this section to STATE.md got wiped by what
looks like another builder's `git reset --hard` running concurrently
mid-stash-dance (visible in `git reflog` as two consecutive "reset: moving
to HEAD" entries) — redone here. If your STATE.md edit vanishes right
after you write it, check reflog before assuming you imagined it.

Not filed as an issue: nothing here hit the "expensive edge case" bar. The
churn windowDays is hardcoded to 14 per the task contract; making it
configurable is a small follow-up if a future round wants it, not done here.

## round 2 task 2 — ambient churn on characters + live gitPath fix

No browser needed for this one (the two lock slots went to tasks 3/4).
Built the third ambient signal end to end: gitsignals.js polls a file's
churn, agent.js turns it into a typing-speed bump and a growing paper
stack.

- **`gitsignals.js`** — new `churnToIntensity(data)`, pure and exported:
  `{ok:true, recent:{commits,added,deleted}, working:{added,deleted}}` ->
  a 0..1 number. Working-tree lines weighted 3x, recent-log lines 0.5x,
  recent commit count 2x, squashed through `1 - exp(-score/40)` so a first
  small edit already registers instead of needing to clear a threshold.
  Malformed `ok:true` body with both `recent` and `working` absent reads as
  `null` ("unknown"), same convention as `statToAgeDays`; a well-formed body
  with genuinely zero churn reads as `0` ("known and quiet") — those are
  different things and the function treats them differently. New
  `pollChurn()` added to the existing `tick()`, same 20s cache/interval as
  the freshness poll. Its failure mode is a true no-op (doesn't call
  `setChurn` at all on a miss) rather than resetting to 0, specifically so
  building against this before task 1's route existed wouldn't fight the
  eased ramp with a false "not busy" every 20s — confirmed this actually
  happened: task 1 hadn't landed `/api/git/churn` when I started, landed it
  mid-session, and the no-op path is exactly what let me build without
  waiting.
- **`anim.js`** — new `setTimeScale(obj, name, timeScale)`. Reaches into the
  mixer's cached-action map directly rather than going through `crossfade`,
  so nudging the typing speed doesn't restart the clip or reset its phase.
- **`agent.js`** — `setChurn(intensity)` next to `setFreshness`, same shape
  (clamps, stores a target, does nothing else synchronously). `update(dt)`
  eases `_churn` toward that target at a fixed rate (`CHURN_EASE`, ~2.2/s)
  so a poll landing mid-keystroke can't snap anything. Two visible effects,
  both driven off the same eased value:
  - typing timeScale, 1.0x..1.6x (`CHURN_TYPE_SPEED`), only while
    `activity === 'typing'` so an idle/walking agent never carries a
    phantom speed-up.
  - a paper-stack prop (`churnGroup`: a tray + a block whose `scale.y` IS
    the eased churn value times `CHURN_MAX_H`), riding the agent root at a
    fixed desk-height guess (`CHURN_BASE_Y = 0.74`, office.html's real
    `DESK_TOP` is 0.76 — close enough, agent.js has no reference to which
    desk mesh an agent is actually at, so this is a decoration next to
    them rather than literally resting on their desk). Grows from the
    tray's surface, not the block's center, so it reads as stacking up.
    Both meshes go fully transparent and `visible = false` below
    `_churn > 0.004` — genuinely zero papers at zero churn, not just
    invisible-but-present.
- **Real data confirmed via curl against a throwaway `pnpm dev --port 5199`
  instance** (never touched the shared 5173 lock — this wasn't a browser
  task) then killed immediately:
  `web/src/office/agent.js` -> `{"recent":{"commits":4,"added":716,
  "deleted":39,"windowDays":14},"working":{"added":69,"deleted":0}}`
  (intensity ~1.0, it's been hammered this round). Checked the whole demo
  cast's actual files too: `python/src/agent_presence/__init__.py` comes
  back intensity ~0.05 (one commit, no lines), `go/cmd/gorelay/main.go`
  ~0.78, `cpp/hook/hook.cpp` and `README.md` both ~1.0. That's real spread
  across the 5-agent cast without touching anything — see below on why I
  didn't also do 2d.
- **2d (vary demo-cast paths), not done, and not really actionable as
  written**: the task described this as a `demo.js` change, but the actual
  file->agent mapping (the `CAST` array with each agent's `file:`) lives in
  `office.html`, which this task was explicitly told not to touch (task 3
  owns it this round). `demo.js` itself has no path data at all — grepped
  for `gitPath`/`file` there, nothing. Since the curl check above shows the
  five existing demo-cast paths already produce five different real
  intensities (0.05 to ~1.0), I'm treating this as already satisfied by
  the existing data rather than a gap.
- **2c (live gitPath staleness fix), also not done, also not actionable as
  written, for the same reason**: the task said "in `live.js`,
  `onLivePresence`..." but `onLivePresence` and `spawnLive` both actually
  live in `office.html` (grepped for both names — `live.js` only has
  `connect()` and the pure `LiveDirector`/`hairFor`; the presence-frame-to-
  character binding is scene-file code, not client code). Round 2's
  integrator pass already documented this exact fix and its exact location
  in the "What's still half-built" section above. Repeating the concrete
  patch here since I couldn't apply it: in `office.html`'s
  `onLivePresence`, right after `if (!a) return`, add `a.gitPath =
  info.path`. One line, safe, not done because it requires touching a file
  outside this task's ownership this round.
- **Paper-stack / typing-speed visuals: UNVERIFIED in-browser.** This task
  had no lock slot and the logic can't be meaningfully checked without
  jsdom/canvas (no test in this repo instantiates a real `Agent` — even
  `badgeTexture`'s `document.createElement('canvas')` would throw in
  vitest's node environment, which is presumably why no prior round tried
  it either). What IS verified: `churnToIntensity`'s math (9 new tests in
  `web/test/churn.test.ts`, real edge cases including the `ok:true` vs
  malformed distinction, working-vs-recent weighting, monotonicity, and a
  non-numeric-input guard) and the poll's wiring into `attachGitSignals`
  (calls `setChurn` on success, silently no-ops on 404/reject/no-gitPath).
  What's NOT verified: whether the paper stack actually looks like papers
  from the office camera angle, whether 1.6x typing read as "busy" instead
  of "broken," whether `CHURN_BASE_Y`/the `0.34, 0.22` offset actually
  clears the character's body without clipping. Round 3 (or whoever next
  has the lock): `window.__zoomAgent` or a stat-panel check on `agent2`
  (mapped to `cpp/hook/hook.cpp`, intensity ~1.0 per the curl check above)
  should show a near-max paper stack and visibly faster typing — that's
  the agent to eyeball first since it has the strongest real signal.
- Also touched `agent.js`'s constructor/`update()` for the churn meshes and
  `despawnLive` in `office.html` was NOT touched, which means `churnGroup`
  leaks on live-agent despawn exactly the same way `freshHalo` already does
  (round 1 gap, not new — noted here so it doesn't look like a regression
  I introduced).

Files touched: `web/src/office/gitsignals.js`, `web/src/office/gitsignals.d.ts`,
`web/src/office/agent.js`, `web/src/office/anim.js`, `web/test/churn.test.ts`.
`agent.d.ts`, `live.js`, `live.d.ts`, `demo.js` — untouched (no pure function
needed exporting from any of them for this task; live.js/demo.js turned out
to not be where the actual work was, per above).

Verified: `pnpm test` (111/111, including the 9 new churn tests) and
`pnpm typecheck` both clean at commit time, re-checked again after a scare
where a concurrent builder's process (this worktree is shared live across
all four, see task 1's note above — I hit the same thing) silently reverted
an in-progress edit to `anim.js` between my Edit call and the next read.
Caught it by grepping for `setTimeScale` before committing rather than
trusting the edit had stuck; redid it, reran the full suite, then committed
and pushed immediately rather than batching further changes. Nothing
filed as a GitHub issue — no edge case here cleared the "expensive to fix"
bar; the two "not done, not actionable" items above are ownership
boundaries for this round, not bugs, and are already tracked precisely
enough in this file for round 3 to pick up as one-line fixes.
