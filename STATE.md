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
