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

## round 2 task 3 — blame card as picture, in variants

Rebuilt `web/src/office/blamecard.js` from the wall-of-text card into two
switchable graphic layouts. Real data only, same `/api/git/blame` and
`/api/git/log` endpoints as before.

- **New `web/src/office/history-viz.js`** — pure helpers, no DOM: an
  author-name -> hue hash (`hueForAuthor`/`colorForAuthor`, same
  multiply-by-31 shape as `palette.ts`'s `hairFor`, re-hosted because this
  path can't import the TS side), a rough relative-age parser
  (`parseRelativeAge`, turns git's `--date=relative` strings like "3 days
  ago" / "2 years, 1 month ago" into a day count), and `ageToX` (log-scale
  0..1 axis position, newest at the right). 11 vitest cases in
  `web/test/history-viz.test.ts`. Has its own `history-viz.d.ts` (same
  reason every other `office/*.js` needs one — see `agent.d.ts`).
- **`blamecard.js`** — two variants, `graphic` (default) and `classic`:
  - `graphic`: ownership as one tug-of-war bar, segments per author sized
    by `share`, coloured by `colorForAuthor`, growing in width on open
    (staggered `setTimeout` per segment, not a snap). History as a dot
    timeline on a log-scaled age axis, dots popping in staggered
    (cubic-bezier overshoot), hover/focus shows subject+author+when in a
    floating tip. This is the one that best matches the brief's "picture,
    not a wall of text" ask — kept as default.
  - `classic`: the earlier per-author stacked-bar-rows + text `<ul>`
    treatment, kept deliberately rather than deleted so the two can be
    compared. Still has its own (smaller) grow-in animation on the bars
    and a staggered fade-up on the list rows — wasn't purely static even
    before this round's ask, just less picture-like.
  - Toggle: press **V** while a card is open (global keydown listener
    inside `attachBlameCard`, no-ops when the card is closed or an input
    has focus), or load with **`?bcVariant=classic`**. There's also a
    small button in the card header showing the current variant name that
    does the same thing on click — worth knowing the button exists but
    keyboard is the more reliable way to drive it from a screenshot-taking
    tool (see the devtools note below).
  - Degrade path unchanged in spirit: `{ok:false}`/network error/absent
    data all still fall through to "no history here yet", never an empty
    box. Verified with a synthetic `{ok:false}` fixture.
- **`office.html`** — no changes needed. `attachBlameCard`'s existing
  `show()`/`hide()` contract didn't change shape, and the V-key handling
  lives entirely inside blamecard.js's own module scope, so the only file
  I touched under `web/src/office/` besides blamecard.js and the new
  history-viz files was blamecard-test.html. Flagging explicitly since the
  task brief called out office.html as mine to touch this round — turned
  out not to need it.
- **New `web/src/office/blamecard-test.html`** — fixture harness, not a
  3D scene (blamecard.js has zero THREE dependency, it's a plain DOM
  controller — the argue-test.html-style canvas rig would've been pure
  overhead here). Five canned fixtures shaped exactly like gitapi.mjs's
  real response bodies (skewed ownership, even 3-way split, solo author,
  no-history, 12 commits spanning minutes to years) behind buttons, plus
  V/variant-button toggling. First version had a bug worth flagging for
  anyone copying the argue-test.html pattern again: `import { x } from
  './y.js?v=' + Date.now()` is a **syntax error** — static `import`
  can't take a computed specifier. argue-test.html gets away with the
  cache-bust trick because it uses `await import(...)` (dynamic), not a
  static `import ... from`. Caught this in-browser as an uncaught
  SyntaxError with an empty page, not in `pnpm typecheck` (plain script
  tag, tsc never sees it) — fixed to the dynamic-import form, verified
  clean after.

**Browser-verified** (took the shared 5173 lock, one tab, protocol
followed): `blamecard-test.html` — all five fixtures screenshot-clean,
graphic variant's tug bar and timeline dots both animate in rather than
snap, V key reliably toggles graphic<->classic (confirmed the content
actually swaps, not just the button label), empty-history fixture shows
the quiet one-liner with no empty box. Then `office.html` via
`window.__zoomAgent('a3')` — real card for `web/src/office/anim.js`,
100% mohsensc ownership (small young file, makes sense), 3 real commit
dots on the timeline, card fully inside its `top:328px; bottom:16px` box
with no HUD overlap. `Escape` restored the room and closed the card.
Console had only the two pre-existing/expected messages (coffee-cup glb
404, relay websocket refused in demo mode) — nothing from this round's
code.

One devtools-tool quirk worth recording since it cost real time: clicking
a freshly re-rendered button by `uid` (from `take_snapshot`) sometimes
resolves to a *stale* node identity after `blamecard.js` tears down and
rebuilds the card body's DOM on every render (it uses fresh
`document.createElement` calls, not in-place mutation) — a click on what
the snapshot called the "graphic" toggle button landed on an unrelated
earlier button instead, silently, no error. Re-verified with `press_key`
('v', `Escape`) instead of uid-clicks wherever the DOM had just been
rebuilt, and that was reliable every time. Not a bug in this code; a
note for round 3 if it drives blamecard.js by uid-click again — prefer
keyboard where a shortcut exists, or re-`take_snapshot` immediately
before every click on this file's elements.

**Shared-worktree hazard, same one task 1 and task 2 both hit, hit again
here**: a bare `git stash` mid-session (before I'd learned to path-scope
it) swept up a duplicate in-progress copy of task 1's STATE.md section
that was mid-write on disk at the time. Popping it back later produced a
real merge conflict in STATE.md (two near-identical versions of task 1's
own paragraph) plus a no-op conflict in `interact.js` (identical content
on both sides, conflict was bookkeeping noise from the stash, not a real
divergence). Resolved by keeping the already-committed side in both
cases and dropping the stale stash entirely — diffed clean afterward.
Repeating task 1 and task 2's advice a third time since three-for-three
is a pattern: never a bare `git stash` in this worktree, always
`git stash push -- <your files>`, or just commit before doing anything
that touches git history at all.

Files touched: `web/src/office/blamecard.js`, `web/src/office/history-viz.js`,
`web/src/office/history-viz.d.ts`, `web/src/office/blamecard-test.html`,
`web/test/history-viz.test.ts`. `office.html` deliberately untouched (see
above). Nothing under `interact.js`, `agent.js`, `gitsignals.js`,
`gitapi.mjs` touched.

Verified: `pnpm test` (111/111) and `pnpm typecheck` both clean at time of
writing this section, re-checked after the STATE.md stash-conflict
resolution above to make sure nothing got silently mangled.

Not filed as an issue: nothing here hit the "expensive edge case" bar.
Symbol-level blame (using task 1's new `start`/`end` blame params) is a
natural round-3 follow-up now that the endpoint supports it — not started
here since nothing in the presence protocol carries a line range yet
(same gap round 1 and task 1 both already flagged).

## round 2 task 4 — whose code is this: desk tint + hover ownership line

All in `web/src/office/interact.js`, browser-verified with real blame data.

- **`ownershipShare(blame, identity)`** — new pure export. Matches an
  agent's identity (`a.role || a.name` — `role` carries the relay's
  `human` field for live agents, `name` is the only thing the demo cast
  has) against blame's `owners[]` loosely: exact, or a substring either
  direction, case-insensitive. Falls back to the top owner with
  `matched:false` rather than nothing — always something honest to say.
  5 tests in `web/test/ownership.test.ts`, plus a hand-written
  `interact.d.ts` (same pattern as `agent.d.ts`/`live.d.ts`) so the test
  typechecks.
- **Hover card line** — after the existing git-stat row, a second row:
  `code is 72% theirs` when the agent's identity matches a blame author,
  `mostly mohsensc's code` when it doesn't (which is every demo agent
  against this repo's real history — "agent-3" was never going to match
  "mohsensc" — confirmed live, see below). Cached separately from the
  existing `gitCache` (stat) — a third independent blame cache, 60s TTL.
  STATE.md already flags two duplicate `/api/git/stat` pollers between
  this file and gitsignals.js; now there's also an uncoordinated blame
  cache in here that duplicates blamecard.js's own blame fetch. Not
  building a shared cache module this round per the task brief — three
  separate small caches against a repo this size is still cheap, but if a
  round 3 touches any of these files, collapsing all of it (stat + blame,
  interact.js + gitsignals.js + blamecard.js) into one shared client-side
  cache module is worth doing once rather than flagging a fourth time.
- **Desk ownership tint, two treatments** — a desk's "resting" colour
  (what `setHover()` restores to instead of raw base) is now
  `d.ownership`: the seated agent's own colour at low alpha if blame says
  the code is mostly theirs, a neutral slate hue if not. Two treatments,
  toggled with **T** or `interaction.setDeskTintMode('steady'|'breathe')`:
  steady is a constant 0.22-alpha wash; breathe is a slow (~10s) sine
  crossfade between the agent's own hue and the neutral hue, same
  "breathe" idea as the existing hover pulse just much slower and driven
  by ownership instead of mouse attention. Recomputed every 3s
  (`scanDesks`, using the same "seated and within 0.55m of the seat mark"
  test `office.html`'s own chair-slide code uses) for whichever desk has
  someone sitting at it with a `gitPath`; desks with nobody seated, or a
  seated background character with no `gitPath` (the demo's `b2`/`b3`),
  correctly resolve to `ownership:null` and stay untinted rather than
  claiming something false.
- **Real bug found and fixed during browser verification**: the ownership
  scan calls `applyRest({kind:'desk', ref:d})` to reapply a desk's resting
  tint outside of an actual hover/click — but `matsOf()` only ever read
  `pick.mats` (present on a real raycast pick from `boxProxy`, absent on
  these synthetic ones). Result: `d.ownership` computed correctly, but the
  material color never actually changed — verified this by reading
  `d.mats[0].color.getHex()` in-browser and finding it stuck at `0xffffff`
  despite `d.ownership.hex` being right. Fixed `matsOf()` to fall back to
  `pick.ref.mats` when `pick.mats` is absent. Confirmed fixed by rereading
  the same material color after the fix: moved from `#ffffff` to
  `#efe9ec` (matched branch, agent's own mauve at low alpha) and
  `#ecedef` (unmatched branch, neutral slate) on two different desks in
  the same scan — both real blame data (`web/src/office/anim.js` for the
  matched case since this repo's whole history on that file is
  `mohsensc`; `go/cmd/gorelay/main.go` for the neutral case with a
  non-matching demo identity).

**Browser verification**, same lock/tab protocol as usual — hit the
"shared worktree" instability hard this round (see below), and also hit
the tab genuinely in use by another builder (`builder3-blamecard`) mid-
session; waited it out, reacquired, restarted the killed vite server.
Cancelled the running demo (`window.__demo.cancel()`) so scripted movement
didn't fight manual placement, seated `a3` at desk 1 (its real `gitPath`,
`web/src/office/anim.js`, all-`mohsensc` history) and gave the demo's `b2`
a synthetic `gitPath` pointing at `go/cmd/gorelay/main.go` for the neutral
case, then drove `scanDesks()`/`hoverAt()` directly through
`window.__interact` — confirmed both desk tint treatments actually paint
(color values above), the hover card's ownership line renders real text
(`mostly mohsensc's code` for `cpp/hook/hook.cpp`, backed by an actual
`last touched 2d ago by mohsensc · 10 commits · 1 author` row from the
existing stat fetch on the same card), and switching `T`/`setDeskTintMode`
between `steady` and `breathe` changes the live material color with no
new console errors (checked `list_console_messages` before and after —
only the two pre-existing, already-understood warnings: the missing
`coffee-cup-v2.glb` asset and the relay websocket refusing to connect,
same as every prior round).

**Screenshot note**: didn't capture a clean side-by-side screenshot of the
two desk tints — the low alpha (0.22) that makes the "ambient, not a UI
badge" call from the task brief is genuinely subtle at this camera
distance/lighting, visible in the material-color readout above but not
obviously so in a full-scene screenshot next to seven other desks. Verified
correctness via material colour, not via a screenshot that would look
underwhelming. If the owner wants the tint more legible at a glance, the
honest fix is raising `alpha` in `interact.js`'s `scanDesks()` (currently
`0.22`), not changing the underlying logic — flagging rather than doing it
unasked since "make it beautiful" and "keep it honestly subtle" pulled in
different directions here and I picked correctness-first.

**On the shared-worktree instability**: hit this hard and repeatedly —
`interact.js` got silently reverted to its pre-round-2 state TWICE mid-task
(once with no trace beyond a system note, once traceable to a `git stash`
race leaving literal `<<<<<<< Updated upstream` / `>>>>>>> Stashed changes`
conflict markers IN the file, which is what actually broke the browser
load — Chrome's parser choked on the raw `<<` with an
`Unexpected token '<<'` `SyntaxError`, no glb/character content, blank
room). Same stash race also left conflict markers in `STATE.md` itself
(two near-duplicate task 1/task 2 write-ups, one per side of the conflict)
— resolved by keeping the more complete "Updated upstream" side and
dropping the redundant duplicate, rather than hand-merging line by line.
Recovered by: reapplying my interact.js edits from what I'd already
written in-session (not from git history, since nothing was committed
yet), committing immediately in small chunks instead of batching, and
`node --check`-ing before every commit rather than trusting the previous
read. If you're round 3 and this worktree is still shared live across
concurrent builders: commit far more often than feels necessary, and treat
"the file I just edited looks different than I left it" as expected, not
a hallucination.

Files touched: `web/src/office/interact.js`, `web/src/office/interact.d.ts`
(new), `web/test/ownership.test.ts` (new). Nothing else — `office.html`,
`blamecard.js`, `agent.js`, `gitsignals.js` untouched, per this task's
ownership boundary.

Verified: `pnpm test` (111/111) and `pnpm typecheck` both clean at the end
of the round, after all four tasks' work landed together.

Nothing filed as a GitHub issue this task — the one real bug (the
`matsOf()` fallback) was cheap enough to catch and fix inline during
verification rather than defer.

