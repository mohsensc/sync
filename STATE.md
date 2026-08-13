# STATE — feat/git-aware-characters

Round 5 starts here. Round 4 ran four parallel tasks: zoom/focus/framing
(this task), churn variants + zoneowner demotion, gitapi dedup + per-line
blame + source route, blamecard variety (timeline stacking, single-owner,
gutter). Read this before touching anything — round 5 has no memory except
this file and `git log`.

## Where things stand

Branch coherent, everything from round 4 merged and pushed.
`pnpm test` — 237/237, 12 files. `pnpm typecheck` — clean. Both verified
fresh at the end of this round.

Commits this round, oldest to newest: `7aaaeb0` (gitapi dedup), `fda2dbd`
(gitapi tests), `bdea055` (zoom declutter + head framing — this task),
`3d998d6`/`41442b6`/`323d288` (blamecard timeline stacking, single-owner
collapse, gutter variant), `6daa4af`/`5df098c` (churn heat/cold treatments,
zoneowner rug default + calm single-owner), `00d42a1` (fixes found verifying
this task's work live — see below).

## This task's build: focus mode, head framing, hover-clear

**Focus mode** (`office.html`, default on, `F` to toggle, `?focus=off`).
While a head-zoom flight has the camera (`priorFraming` set), the zoomed
state used to pile up: blame card, stale hover card, the corner selection
panel, a zone label pill, a zoneowner plaque/rug, and the demo caption all
stating some version of the same fact. Focus mode now drops everything but
the character and the blame card for the duration of the zoom:
- `zones.js`'s `buildZoneMarkers()` label pills get a real `updateCamera()`
  distance fade (same shape as `zoneowner.js`'s `09b6ca3` fix — hidden below
  3m, full above 5.5m) PLUS a hard `setFocusHidden()` override for focus
  mode, since distance fade alone wasn't enough to fully clear them.
- `interact.js`'s corner panel (`#ip`) and hover tooltip (`#it`) get a
  `setFocusMode()` toggle on the interaction API; both also got a proper
  opacity/transform transition instead of a hard `display` snap, since this
  round's brief called out that mechanical motion reads as cheap.
- The zoneowner plaque/rug root (`scene.getObjectByName('zoneowner-root')`)
  gets hidden outright via `.visible` — read-only reference to a name
  `zoneowner.js` already exposed, no edit to that file needed.
- The demo caption gets a `.declutter{opacity:0}` CSS override.
All of it restores on Escape/deselect via the same `updateDeclutter()` call
that turns it on.

**Head framing** (`office.html`, `headFraming()`). The old flight kept
whatever yaw/pitch the room camera happened to be at before the click —
literally luck, confirmed live (a top-down orbit before selecting someone
landed the head-zoom on a scalp). Now derives from the character's own
`a.yaw`: `'threequarter'` (default) faces them roughly head-on with a
slight offset so it doesn't read as a mugshot; `'shoulder'` sits behind
and to the side, wider, framing past them toward their desk. Switchable via
`window.__zoomMode.setFrame('shoulder'|'threequarter')` / `?frame=`.

Found and fixed a real bug building this: the yaw clamp (`Math.max(MIN,
Math.min(MAX, y))`) is periodicity-blind. `a.yaw + PI` routinely lands past
a full turn, and a plain min/max picks whichever raw number is smaller —
not necessarily the nearest point on the circle. Replaced with `clampYaw()`,
which wraps to the representative nearest the arc's centre before clamping.
Pitch also now animates as part of the flight (it never did before — this
is what let a top-down orbit's pitch carry straight into a close-up).

**Known real limitation, filed as #64, not fixed this round**: the room's
valid camera arc is only ~68° wide (cutaway room, open on +x/+z only). For
characters facing away from that hemisphere — front-row desk sitters
(`Z.ZONES.desks.slots[0..2]`, yaw 0, facing their own desk toward the back
wall) are the common case — even the nearest reachable point on the arc is
90°+ off from a true face-on shot, so `threequarter` still lands on a
back/side view for them. Confirmed live: `a1`/`a2` (front row) land on the
back of the head; `a3` (facing the vault, closer to the arc) lands cleanly
on the face. `shoulder` mode is the more reliable default for desk-seated
characters in practice — it targets `a.yaw` directly, which empirically
lands inside the arc far more often for this room's actual layout. Issue
#64 has the detail and possible directions (widen the arc specifically for
head-zoom's close range, or revisit desk seat yaws).

**Stale hover card** (`interact.js`). Used to only clear on the next
pointermove, so it could sit mid-screen describing the wrong agent after a
click, a keyboard select, or `zoomToAgent()`. Now `select()` clears it
unconditionally (reuses `setHover(null)`'s existing rest-state logic, so a
desk's ownership tint still restores correctly), and `zoomToAgent()` also
calls the new `interaction.clearHover()` directly as a second guard for any
future call path that reaches it without going through `select()` first.

**Also found and fixed live, not in the original plan**: `interact.js`'s
CSS had `#it.card{display:flex;flex-direction:column}` with no `.on` gate
(added in round 3 for the 'rich' treatment's `order`-based reordering
trick). Same specificity as `#it.on{display:block}`, later in the sheet, so
it always won — meaning once a card-treatment tooltip had ever rendered,
nothing could hide it again, `.on` or not. This is exactly why the
stale-hover-card fix above looked broken in the browser until this turned
up as the actual cause. Fixed: `#it.card.on{...}`.

## Verified live this round

Browser session had real friction worth flagging for round 5: my server
died between Bash calls twice (background `(cmd &)` doesn't survive a Bash
tool call boundary without `nohup ... < /dev/null &` + `disown` — a plain
subshell background job gets SIGHUP'd when that call's shell exits), and
both times a stray `sync-featB` vite process silently took the now-free
port 5173 before I noticed, so I was actually testing featB's build for a
while without any error to signal it (`window.__ready` was true, but
featB's `office.html` predates several of the globals I was checking for,
which is what actually tipped me off). Issue #62 already covers the port-
theft half of this; the "background job dies on its own" half is new and
worth the next round's server-start step reading: use
`nohup cmd > log 2>&1 < /dev/null & disown`, then verify with `lsof -ti
:5173` from a SEPARATE Bash call (not the one that started it) before
trusting the tab.

Once actually pointed at this worktree's server:
- Focus mode on: zoomed `a2` and `a3` — screenshot shows character + blame
  card only, no zone pill, no zoneowner plaque, no caption, no corner panel.
  Confirmed via DOM query too (`zoneOwnerVisible:false`, pill
  `opacity:0`, `panelOn:false`, `tipOn:false`, caption has `declutter`
  class).
- Focus mode off (`window.__focusMode.set(false)`) on the same zoom: the
  zone pill balloons across the character's face and the corner panel
  reappears — exactly the pile-up the fix addresses. Good before/after pair.
- Both framing variants: `threequarter` on `a3` lands cleanly on the face;
  `shoulder` on `a1` gives the wider over-the-shoulder desk view. See the
  limitation above re: `threequarter` on front-row desk sitters.
- Stale hover card: hovered `a1` (card visible, `display:flex`), clicked
  `a3` via real dispatched pointer events (not the `__clickAgent` shortcut —
  exercises the actual listener chain), tip fully `display:none` afterward,
  `a3` selected. This is also how the CSS bug above got caught — the first
  attempt showed the tip still stuck, before the fix.
- `H` treatments: `nameplate` and `rich` both screenshotted as pixels
  (open items from round 3 and the round-4 integrator pass). Nameplate
  floats a small navy pill over the head; rich promotes the "whose code"
  line above doing/zone/file via the `order` CSS.
- `Z` snap mode: sampled camera distance every ~30-60ms through a snap
  flight — dist dips to 2.89 (past the 4.32 resting point) before easing
  back and settling, the expected overshoot-and-settle shape. Also
  screenshotted mid-flight.

Not reached: churn visuals were task 2's first-priority item this round,
not this task's — see their commits (`6daa4af`, `5df098c`) for what they
verified themselves before I took the lock.

## Key registry (current, no collisions)

B (histshelf) / C (churn treatment) / F (focus mode) / H (hover treatment) /
R (blame region) / T (desk tint) / U (zone ownership) / V (blame variant) /
Z (zoom feel) / Escape (deselect). `?focus=off`, `?frame=`, `?churnMode=`,
`?zoMode=`, `?bcVariant=` are the matching query params.

## What's NOT built yet / still genuinely open

- **#64** (filed this round): threequarter head framing can't reach a
  face-on shot for characters facing away from the room's valid camera arc
  — front-row desk sitters, concretely. `shoulder` mode is the practical
  workaround today.
- **#62**: shared port 5173 gets stolen by other worktrees mid-lock. Hit it
  twice this round from a new angle (my own backgrounded server dying
  between Bash calls, not just another team's cleanup racing mine). See the
  "Verified live" section above for the `nohup`/`disown` fix.
- **#59**: `coffee-cup-v2.glb` 404, still open, still cosmetic-only.
- **Symbol-level blame beyond a line range**: unchanged from round 4 — the
  gap is upstream of this branch (C++ hook / Go relay don't populate
  `region.start`/`end` on real presence frames yet).
- **Three-plus independent client-side git-data fetchers, no shared cache**:
  still true, still cheap, still not worth a standalone task. Now includes
  `zoneowner.js`'s shortlog poll (its own note explains why), plus whatever
  task 4's gutter variant added on top of `blamecard.js`'s existing fetch
  for the `source`/`lines` routes.
- **Churn typing-speed/paper-stack + new heat/cold treatments**: task 2's
  own commits are the source of truth on what they verified; not re-checked
  by this task.

## Filed this round

- **#64** (this task): head-zoom threequarter framing geometry limit, see
  above. `enhancement`, `priority:nice-to-have`, `area:web`.

Nothing else needed filing — the CSS display bug and the yaw-clamp
periodicity bug were both small enough to characterize and fix inline in
the time it took to find them.
