# STATE — feat/highlight-reel

Round 1. Branch and PR set up, no feature code yet. This file is the map for
round 2 onward — read it before touching anything.

## What round 1 did

- Worktree at `/Users/mohsen-agentai/src-2/sync-featB`, branch
  `feat/highlight-reel` off `origin/main` (deca526).
- git identity set locally: mohsensc / mohsensarrafanc@ucla.edu.
- `cd web && pnpm install && pnpm approve-builds esbuild` — needed once per
  worktree, esbuild's postinstall is gated by pnpm and vitest won't run
  without it. `pnpm test` and `pnpm typecheck` both pass clean on main as of
  this branch point (38 tests).
- No feature code written yet. This round was read-and-plan only.

## The product, restated for a round with no memory

Coding agents on the same repo can't see each other. A C++ hook feeds a Go
daemon; a Go relay (`go/internal/relaysrv`) owns leases and arbitration;
`web/src/office/` renders it as an isometric office, one character per agent.
The collision ladder, rungs 0-4:

- 0 co-location — two agents in the same zone, no real conflict
- 1 one reads while another edits
- 2 same file, disjoint symbols — safe to work alongside
- 3 same symbol, contested — a real block
- 4 redundant work discovered by intent-similarity, different files

Feature B (this branch): a highlight reel panel, top right, listing every
clash, ranked by rung, filterable, newest first. Click one and the scene
replays it: the two characters colliding, then a resolution animation that
maps to what the arbitration layer actually decided.

## The scene as it exists today

`web/src/office/` is unbundled plain JS (import maps in office.html, no
bundler on this path — it cannot import the `web/src/*.ts` side, see
live.js's header). Files, what they own:

- **office.html** — the THREE scene: room, props, character spawning,
  camera, the click-to-select HUD, the live/demo mode switch. Owns every
  THREE object; live.js and demo.js are pure logic that hand it instructions.
  CSS layout worth knowing before adding a panel: `#hud` top-left, `#beat`
  **top-right** (`right:18px;top:16px`, a small monospace demo-step readout),
  `#mode` top-center pill (live/demo/connecting badge), `#caption`
  bottom-center, `#log` bottom-left. The reel needs the top-right corner
  `#beat` already sits in — either the reel absorbs/replaces `#beat`'s job
  (it's just "current demo beat" text) or they stack, but the corner is not
  empty today.
- **live.js** — `connect()` (websocket to the relay, one join frame, defensive
  JSON parsing — mirrors `web/src/subscribe.ts`, re-hosted here because this
  path can't import it) and `LiveDirector` (pure bookkeeping: presence frame
  in, `{zone, contestWith, shareWith, spawned}` out). No THREE. Unit tested
  in `web/test/office-live.test.ts` — that's the pattern for testing
  highlight-reel logic too (plain describe/it against the class, no DOM).
- **demo.js** — `runDemo(ctx)`, six scripted captioned beats, used when the
  relay doesn't answer within 1.5s (`LIVE_TIMEOUT_MS` in office.html). This
  is also the shape a "convincing generated history" for the reel's empty
  state should probably follow — captioned, cancellable, clearly synthetic.
- **agent.js** — `Agent` (activity state machine + steering) and `World`
  (owns agents, brokers *paired* actions via an `encounters` array with
  phases `approach -> settle -> active -> done`). This is the seam the reel's
  playback hangs off. `World.highfive(a,b)` and `World.contest(a,b)` are the
  two paired-action entry points that exist today; `World.resolveContest(e)`
  ends a contest early. A third, `World.handshake(a,b)`, does **not exist
  yet** — see below.
- **anim.js** — 9 procedural clips against the 24-bone rig, `ACTS` table maps
  activity name -> `{clip, fade, oneShot?, next?, seated?}`. `ANIM.CLIPS` is
  the clip registry; other modules fold their own clips into it at import
  time (`Object.assign(ANIM.CLIPS, ARGUE_CLIPS)` in agent.js).
- **interact.js** — click to select/send/sit. Not yet relevant to the reel
  except as the existing pattern for click handling in this scene.
- **zones.js** — `zoneFor(verb, path)` -> named floor zone, `PALETTE` (also
  duplicated by hand in live.js's `HAIR` — cross-toolchain-boundary copies
  are the established pattern here, not a bug).
- **dressing.js** — non-interactive set dressing. Not relevant to the reel.

## Animation clips: what's built, what's wired, what's missing

Three paired-action clip modules exist. "Wired" means `World` has a method
that walks a pair onto marks and starts it, and `ACTS`/`ANIM.CLIPS` know
about it. "Built" means the clip and its `-test.html` harness exist.

| clip | file | built | wired into World | maps to |
|---|---|---|---|---|
| high five | `highfive.js` (office root, not clips/) | yes | yes — `World.highfive`, also auto-fires on `onArrived` when two idle agents end up close | rung 2 (collaboration) or a plain friendly greeting |
| argue / argueReact | `clips/argue.js` | yes | yes — `World.contest`/`resolveContest`, driven live by `LiveDirector.contestWith` (rung >= 3, same path) | rung 3, the *in-progress* contest state, not a resolution |
| handshake | `clips/handshake.js` | yes | **no** — no `World.handshake`, no ACTS entry, nothing calls it | candidate for "one takes it, other waits" (decisionWait) |

Each built clip follows the same shape, and any new clip should too:

1. One canonical spacing (`spacingFor(height)`), derived from the clip's own
   authored contact geometry in armature cm, not IK.
2. `xMarks(aPos, bPos, spacing)` — where the pair stand, on the line between
   them, centred, facing each other.
3. Both play the *same* clip when the action is symmetric (mirrored by
   facing each other — highfive, handshake). An asymmetric beat (argue) is
   two different clips, phase-matched, started the same frame.
4. Clip built by hand from `ANIM.BONES`/`ANIM.BIND` + `ANIM.applyPose`,
   because `anim.js` doesn't export its own clip-building internals
   (`buildClip`, `deltaQuat`) — only `applyPose`. `clips/handshake.js`'s
   header explains this at length; copy its `makeRig`/`buildClipFromSpec`
   scaffold rather than re-deriving it.
5. A `*-test.html` harness, standalone, no full scene load — this is how
   motion gets iterated on. `highfive-test.html` runs three pairs at random
   start distances and reports the palm gap; `argue-test.html` and
   `handshake-test.html` follow the same idea.

`clips/argue.js`'s header has a live note: the brief for that clip wanted
`clips/social.js`, but by the time it was written another round had already
put a **chest bump** there. That file does not exist in this tree right now
(no `clips/social.js`, no `chestBump` anywhere) — it's either sitting in the
parallel worktree (the other feature team, off limits) or was reverted.
Don't assume it exists; don't build around a chest bump that isn't there.
If it lands later from wherever it's coming from, rung 2's "collaboration"
beat has two candidates (chest bump, or reuse high five) — pick one, don't
build a fourth.

## The resolution mapping — what data is actually available for it

This is the part that needs the most care, because the wire data is
lopsided: the browser gets less than the relay actually decides.

**What `live.js`'s `LiveDirector` sees today:** only `"presence"` frames —
`{agent, human, verb, region, rung}` — and the `"leases"` join snapshot.
`connect()`'s `ws.onmessage` silently drops every other frame type
("everything else on the wire is silently ignored," per live.js's own
comment). `rung` rides on presence frames for real
(`go/internal/relaysrv/relay.go`'s `onEvent`, ~line 668, puts it there), so
rung 0-4 badges are honest today. But *why* something resolved the way it
did is carried on frame types the browser never reads:

- `"negotiate"` (relay.go ~line 703) carries `decision` (`"wait"` or
  `"abort"`, from `waitDieDecision` in `go/internal/relaysrv/waitdie.go`),
  `priority`/`holder_priority` (principal tier names), `holder_agent`,
  `holder_human`, `handover_to`.
- `"claim_result"` on a refused claim (relay.go ~line 815 onward) carries the
  same `decision` field, plus `effect`.
- `"redundant_work"` / the `"redundant"` payload on a granted claim
  (`redundancyPayload`) is rung 4's frame — `agent`, `human`, `intent`,
  `region`, `score`.

`resolveWaitDie` in `go/internal/relaysrv/waitdie.go` is the actual
arbitration: compares `(tier, acquired-at, agent-id)` tuples —
`decisionWait` if the requester is strictly more entitled (lower rung,
i.e. earlier and/or higher tier — I mean literally "wins the order"),
`decisionAbort` otherwise. This is precisely the brief's two outcomes:

- `decisionWait` = "they agreed one takes it for now" -> handshake / you-go-
  ahead gesture. The waiter isn't wrong, just later or lower tier — no
  animosity.
- `decisionAbort` = "one out-authoritied the other" -> the dominant/mean
  beat (slap, shove, dismissive wave). This is wait-die aborting the
  younger transaction, or a straight priority-tier win — same frame field
  either way, `decision: "abort"`.

**Conclusion: `live.js` needs a second hook, not just `onPresence`.** To show
real resolutions (not just synthetic ones) the reel needs `connect()` to
also surface `negotiate`/`claim_result`/`redundant_work` frames — right now
those types aren't even named in `live.js`, let alone parsed. This is
probably the single biggest piece of plumbing this feature needs before any
of it can be "real" rather than "generated." Options for round 2: add a
second callback (`onDecision` or similar) to `connect()`'s config, matching
the existing `isPresence`/`isLeasesSnapshot` guard-function pattern; keep it
additive so nothing about the existing presence path changes.

Until that lands, the reel's real-data feed is necessarily rung-only
(presence frames give rung + who + what, never the decision) — which is
fine for ranking/filtering/chronology, but the *resolution animation* is
guesswork without the decision field. Be explicit in the UI about which
events have a resolution sourced from a real decision frame and which are
inferred/generated — the brief calls this out specifically ("never present
invented events as real ones").

## Rung -> beat mapping, first cut

| rung | situation | resolution beat | clip status |
|---|---|---|---|
| 0 | co-location, no real conflict | low-key acknowledgment, maybe nothing | — |
| 1 | one reads while another edits | a glance / step-aside, smaller than a full paired action | not built |
| 2 | same file, disjoint symbols | high five (built, wired) or chest bump (not in this tree) | highfive.js |
| 3, decision=wait | contested, requester waits | handshake / "you go ahead" gesture | handshake.js built, **not wired into World** |
| 3, decision=abort | contested, requester aborted (wait-die or priority) | dominant/mean beat — slap, shove, dismissive wave | not built |
| 4 | redundant work, different files | its own beat — something like a double-take / "oh, you too" | not built |

The `argue`/`argueReact` pair that's already wired is the *in-progress*
rung-3 contest state (the standoff itself, loops until resolved) — not one
of the resolution beats above. Keep that distinction in the UI: contest
clip while `contestWith` is live, resolution clip once it clears.

## What's next (not started)

1. Wire `World.handshake(a, b)` following `World.highfive`'s shape exactly
   (marks from `handshakeMarks`, same-frame same-clip start). Cheapest win,
   the clip already exists.
2. Build the "dominant" clip (slap/shove/wave) and its own `-test.html`
   harness — this is new motion work, budget real time on it, the brief
   asks for weight/anticipation/follow-through, not a first draft.
3. Build the rung 1 and rung 4 beats — smaller, can be quick reads (a
   glance-and-yield for rung 1, a double-take for rung 4) rather than full
   paired routines.
4. Extend `live.js`'s `connect()` to surface decision frames (see above) —
   needed before the reel can label anything "real" beyond the rung.
5. The reel panel itself: top-right, rung-ranked, filterable by rung and by
   human/agent, newest-first, contrast against the 3D scene behind it,
   sensible empty and long-list states. Needs to coexist with or replace
   `#beat`.
6. A generated/seed history so the reel isn't empty on a fresh checkout —
   follow demo.js's "clearly scripted, clearly captioned" precedent, and
   label it as generated in the UI per the brief.
7. Click-to-replay: an event selected in the reel should drive `World`'s
   paired-action machinery directly (same `encounters` array, same
   phase machine) rather than a new playback system.

## Rejected / not attempted this round

Nothing built yet, so nothing rejected. This round was scoping only.

## Filed issues

None yet. No edge case has been hit hard enough to need one — round 1 was
reading, not building.

## Round 2, task 4 — rung 1 and rung 4 clips, unwired

Built `clips/yield.js` and `clips/doubletake.js`, following handshake.js's
scaffold (own scratch rig, own `buildClipFromSpec`, no shared internals
with anim.js — same reason as every other file in `clips/`). No browser
this task; verified with `web/test/office-clips-geometry.test.ts` (marks
centred/facing, spacing positive and height-scaled, real `AnimationClip`
track shapes, finite poses across the sampled range, plus a specific check
that doubletake's pre-snap pause actually holds still before the snap).
`pnpm test` and `pnpm typecheck` both pass (89 tests total across the
branch as of this commit).

- `clips/yield.js` — rung 1, read-vs-edit. Asymmetric pair: `yieldStep`
  (the reader — glance up, open-palm "after you", small backward weight
  shift) and `yieldKeep` (the editor — a brief nod, arms stay in a
  typing-adjacent posture). Deliberately smaller/shorter (1.7s, tighter
  0.62m spacing) than the paired routines — a beat, not a scene, per the
  brief. Exports `spacingFor`, `yieldMarks`, `registry`, `getClip`, plus a
  `yieldRoutine` for parity with handshake.js/argue.js even though nothing
  calls it yet.
- `clips/doubletake.js` — rung 4, redundant work. Symmetric pair, same clip
  both play (mirrored by facing, like highfive/handshake): look, look away,
  a held pause, a fast snap back, hold, then a mirrored palms-up shrug. The
  pause before the snap (`DT_PAUSE_END`) is an explicit named window, not
  an emergent side effect of overlapping bump()s — that gap is the whole
  joke. 2.6s one-shot, 1.35m spacing (wider than a greeting; redundant work
  is usually spotted across the room). Same export shape as yield.js.
- `.d.ts` files added for both (`yield.d.ts`, `doubletake.d.ts`) — office/
  is outside tsconfig's `allowJs` surface, same reason `live.d.ts`/
  `reel.d.ts` exist; without them the geometry test fails typecheck with
  TS7016.
- `-test.html` harnesses for both, modeled on handshake-test.html (one pair
  per run, re-randomized on "Run again", a scrub slider, mark dots,
  finite/seam checks exposed on `window`). **Neither has been opened in a
  browser** — this task was scoped no-browser. Say this plainly for round
  3: the motion is a first draft off the pose math alone, not off how it
  actually reads. Load `yield-test.html` and `doubletake-test.html` and
  iterate before wiring them into `World`.
- Not touched: `agent.js`, `office.html`, `live.js`, `reel.js`, `seed.js`,
  `shove.js` (another task's file, in progress in the same tree this
  round — left alone).
- No rig limitation blocked anything here (open-palm and palms-up shrug are
  both just wrist/palm targets, same mechanism highfive/handshake already
  use) — no issue filed.
- Wiring for round 3+: `World.yield(a, b)` and `World.doubletake(a, b)`
  following `World.handshake`'s shape once that lands (marks from
  `yieldMarks`/`doubletakeMarks`, `Object.assign(ANIM.CLIPS, registry)` for
  each, ACTS entries `yielding: { clip:'yieldStep', ... }` /
  `keeping: { clip:'yieldKeep', ... }` / `doubletaking: { clip:'doubletake',
  ... }`). Genuinely close to the five-line job the brief describes.

## Round 2, task 1 — the reel panel on screen

Built `web/src/office/reel.js` and wired it into `office.html`, top-right,
in the corner `#beat` used to own. Browser-verified (see below).

- `ReelStore` — pure logic, no DOM. `add(event)` keeps the list sorted
  newest-first (stable sort, ties keep insertion order); `setRungFilter`
  (`0-4` or `'all'`), `setHumanFilter` (a name or `'all'`, matches either
  side of the pair), `visible()` for the filtered view, `humans()` for the
  filter dropdown's options. Severity rank is just the rung, per the brief.
  Tested in `web/test/office-reel.test.ts`, same no-DOM style as
  `office-live.test.ts` (ordering, single/combined filters, empty-result
  behavior, human dedup).
- `mountReel(container, store, {onSelect})` — the render layer. Draws a
  header (title + `n/total` count), rung filter chips (`ALL`/`R0`-`R4`),
  a human `<select>`, the scrollable row list, and a footer line the caller
  drives independently (`setFoot(html)` — this is what replaced `#beat`).
  Each row: rung badge color-graded cool-to-hot (slate R0 → sage R1 →
  mustard R2 → caramel R3 → red R4), `human/agent vs human/agent`, a
  live/generated source tag (`.reel-src-live` green, `.reel-src-gen`
  neutral grey — never unlabeled, per the brief), truncated path, a
  human-readable resolution phrase, and relative time. Empty-filter state
  reads "nothing here — try a wider filter" instead of a blank box.
- 12 hardcoded `SAMPLE_EVENTS`, all `source:'generated'`, spread 1 minute to
  ~3 hours back, one per rung repeated across a few pairs/paths so the panel
  reads full without being empty on a fresh checkout. `seed.js` (built in
  parallel this round, not imported here) is the real generated-history
  generator for next round — swapping `SAMPLE_EVENTS` for `seedEvents(...)`
  in office.html is a one-line change once it's wired.
- `reel.d.ts` added alongside, same reason `live.d.ts` exists — office/ is
  outside tsconfig's `allowJs`, so the vitest file needs a hand-written
  declaration to import against.
- office.html: `#beat` div removed, replaced with `#reel` (CSS in the
  existing `<style>` block, matching `#hud`'s card look — `#fffdfaee` bg,
  `#C3B39B` border, `0 6px 24px #4a1f3d18` shadow). Capped at `60vh` with
  `overflow-y:auto` on the row list so a long history scrolls inside the
  panel instead of pushing it off-screen. `onSelect` currently just calls
  the existing `caption()` with "replay: who vs who" — actual playback
  through `World`'s encounter machinery is next round's job, once a task
  owns `agent.js` again.
- Also fixed a pre-existing bug flagged in the browser protocol doc:
  office.html's prop/character `url:'glb/...'` references are relative,
  which 404s under `/src/office/office.html` (resolves to
  `/src/office/glb/...`, doesn't exist). Changed every `glb/...` reference
  to `/glb/...`. This is a real fix, not scaffolding — worth calling out in
  the PR body. Whoever reads this next: it's done, don't redo it.
- Filed #59: `coffee-cup-v2.glb` is referenced three times in `PROPS` but
  was never in `web/public/glb/` — unrelated to the path fix above (it's
  genuinely missing, not misresolved). Doesn't block anything, the scene
  just quietly has no coffee cups; console shows three 404-as-JSON parse
  errors per load.

Browser-verified with the shared lock (port 5173, tab 6): screenshot with
the demo running and the reel populated over the scene reads clean —
contrast is good against both the cream scene background and the busy
character/prop area behind it, chips filter correctly (`ALL`→`R3`→`R4`
checked live, counts updated `12/12`→`4/12`→`2/12`), the human `<select>`
combined with `R4` + `sara` produced the empty state correctly, and the
demo's own beat/done text kept updating in the panel's footer exactly like
the old `#beat` did. Only console noise was the expected relay-unreachable
WebSocket error (no relay running) and the three coffee-cup 404s (#59).

Not touched: `live.js`, `live.d.ts`, `agent.js`, `seed.js`,
`clips/*` — other tasks' files, left alone.

What's next for the reel specifically: wire `seed.js`'s `seedEvents()` in
as the real generated history (swap for `SAMPLE_EVENTS`), wire `live.js`'s
`onDecision`/`onRedundant`/`toReelEvent` in as the real feed once `agent.js`
exposes enough of `World` to actually replay a clip from a click, and swap
`onSelect`'s caption stand-in for real playback once `World.handshake`/
`World.shove`/etc. exist to drive it.

## Round 2, task 3 — wired handshake, built shove

Owned `agent.js` this round (only task allowed to touch it) plus the new
`clips/shove.js` and `clips/shove-test.html`.

- **`World.handshake(a, b)`** now exists, same shape as `World.highfive`
  exactly: `handshakeMarks`/`spacingFor` from `clips/handshake.js`,
  same-frame same-clip start (`handshaking` ACTS entry, `clip:'handshake'`),
  ends on `ANIM.getClip('handshake').duration + 0.2` like highfive does.
  This is the rung-3 `decision:"wait"` beat — handshake.js was fully built
  and harness-tested in an earlier round but nothing called it; now
  something does.
- **`clips/shove.js`** — new, the rung-3 `decision:"abort"` beat (one agent
  out-authoritied the other). Asymmetric pair like argue: `shove` (winner,
  two-hand push) and `shoveReact` (loser, jolt/stagger/droop), same
  `{fn,dur,keys,loop}` registry shape, same scratch-rig scaffold copied from
  handshake.js's header (anim.js doesn't export clip-building internals).
  `World.shove(winner, loser)` wired in following `contest()`'s asymmetric
  shape but, like highfive, ends on its own clip length rather than looping.
  Poses are authored as full milestone dicts blended with a generic
  `lerpPose` (array-lerp on every bone key at once) rather than
  handshake.js's narrow 11-field array scheme — simpler to author when a
  pose touches both arms, torso, and hips together, which this one does.
- **Contact geometry, solved not eyeballed**: grid-searched the arm joint
  angles (shoulder/arm/elbow) for the combination that lands the right palm
  on the character's own midline at chest height — same "own midline"
  contract highfive.js's `HF_CONTACT` documents. `CONTACT_Y_CM`/
  `CONTACT_Z_CM` are read off that solved pose (`measureContact()`), not
  chosen independently of it.
- **Spacing bug, caught and fixed in-browser**: first pass doubled the
  reach the way highfive/handshake/argue all do (`2 * CONTACT_Z_CM`) — right
  for a MUTUAL contact (both sides reach toward the shared midpoint), wrong
  for a shove, which is one-sided (only the winner's hand travels; the
  loser's body just stands at their own root). Doubled, the palm landed
  58cm short of the loser's chest in `shove-test.html` — looked like two
  people waving near each other, not a shove. Fixed to a single reach plus
  a small chosen `BODY_DEPTH_CM` buffer (20cm, not measured — the rig has no
  torso depth to measure), which lands the palm within ~20cm of the chest
  and, just as important, keeps the two heads from ending up nose-to-nose
  (a side effect of the winner's forward lean at the tight un-buffered
  spacing). See the constant's comment in `shove.js` for the full story —
  if the shove ever reads as not-quite-touching or as too intimate, that
  buffer is the knob.
- **Deliberate rule break, called out in the file header**: every other
  paired clip keeps `hips:[0,0,0]` throughout (dragging the pelvis drags the
  feet). The loser's "staggers back a step" is exactly that drag, done on
  purpose (`STEP_BACK_CM = 34`) — there's no walk-cycle/IK to blend a real
  recovery step out of, and at this clip's length a hip slide reads as a
  stumble, not a skate. Flagged in case it reads wrong once seen at full
  scene scale/lighting rather than the harness's plain floor.
- Captions/ACTS: `handshaking` ("shaking on it"), `shoving` ("pulling
  rank"), `shoveReacting` ("shoved aside") — dry, not neutral, per the
  brief's "funny and a little mean" for the abort beat.

Browser-verified with the shared lock (port 5173, tab 6):
`shove-test.html` (three pairs, random start distances) — iterated twice on
spacing (see above) until `Hold contact` reads a clean two-hand push
against the chest at a sane standing distance, not a whiff and not a
face-plant. Screenshots at t=0.10 (windup, arm cocked back), t=0.55 (jolt —
loser's head snapped back, reads well), and t=1.0 (droop — loser visibly
stepped back, head down; winner relaxed, arm dropped) all read as intended.
Then loaded `office.html` and ran `World.handshake`/`World.shove` end to
end from the console on idle agent pairs (`window.__world`,
`window.__agents` are exposed) — both encounters completed cleanly, both
agents returned to `idle`, `world.encounters.length` back to 0, no new
console errors. Did not get a visual read of either beat inside the full
scene itself (task 1 fixed the glb path bug this same round; hadn't
confirmed characters render before I smoke-tested from the console — worth
a follow-up screenshot next round, low risk since the harness confirms the
motion and the console smoke test confirms the wiring).

Not touched: `office.html`, `live.js`, `live.d.ts`, `reel.js`, `seed.js`,
`clips/yield.js`, `clips/doubletake.js` — other tasks' files.

No GitHub issue filed this round — no edge case hit that was expensive
enough to defer; the one real problem (spacing) was cheap to fix once
found and is documented above and in `shove.js` itself.

What's next: `World.yield`/`World.doubletake` wiring once `yield.js`/
`doubletake.js` land and get a visual pass (per round 2 task 4's own
notes above) — five-line job in `agent.js`, same shape as `handshake`.
Also worth a real screenshot of `World.handshake`/`World.shove` firing
inside the full lit scene (not just the plain-floor harness) now that
characters should render there.

## Round 3 — integration

Four builders landed round 2 concurrently (the four sections above, one
per task). This round's job: pull it together, make sure it actually
runs, wire up what got built-but-not-connected, and look at it. Branch
was coherent going in — no merge conflicts, no duplicated helpers, all
four builders' commits pushed cleanly on top of each other. `pnpm test`
(89/89) and `pnpm typecheck` both passed clean before I touched anything.
That's a good sign for how the round's git discipline held up (path-scoped
commits, nobody stepping on shared files) — worth doing again.

**What was actually broken: nothing crashed, but three pieces of round 2
work were built and tested in isolation and never connected to anything.**
That's the normal cost of four builders working the same tree without
talking to each other — nobody's fault, it's exactly what this round
exists to catch.

1. **`seed.js`'s 25-event generated history was never imported.** Task 2
   built it, task 1 built the reel panel with its own 12 `SAMPLE_EVENTS`
   in parallel, and the two never got introduced. Fixed: office.html now
   does `new ReelStore([...SAMPLE_EVENTS, ...seedEvents()])` — 37 events
   on a fresh checkout instead of 12. No id collisions (`sample-N` vs
   `seed-N`).
2. **`live.js`'s `onDecision`/`onRedundant` callbacks were never passed to
   `Live.connect()`.** Task 2 built the whole negotiate/claim_result/
   redundant_work parsing path, tested it 17 ways, and office.html's
   `initLive()` only ever wired `onPresence`. Fixed: added
   `onDecision: onLiveReelFrame, onRedundant: onLiveReelFrame` to the
   `connect()` call; `onLiveReelFrame` runs the frame through
   `Live.toReelEvent`, adds it to `reelStore`, re-renders. This is real
   plumbing now, not dead code — see the caveat below on what it can't do
   yet.
3. **`World.yield`/`World.doubletake` didn't exist.** Task 4 built
   `clips/yield.js` and `clips/doubletake.js` fully (marks, spacing,
   registry, geometry-tested) but explicitly scoped "wiring is next
   round" — task 3 had `agent.js` locked for the round and only had
   budget for handshake + shove. Wired both this round, same shape as
   `World.handshake`/`World.shove`: `yielding`/`keeping` ACTS entries
   (asymmetric, like shove), `doubletaking` (symmetric, like highfive),
   folded both registries into `ANIM.CLIPS`, added both to the
   phase-machine's same-clip/different-clip dispatch and the
   `CLIP_OF_KIND` end-timing map. All five resolution beats
   (highfive/share, handshake/wait, shove/abort, yield/read-yield,
   doubletake/redundant) are now reachable through `World`.

**Also built this round: the reel actually replays now.** Task 1 left
`onSelect` as a caption stand-in on purpose ("actual playback... next
round's job, once a task owns agent.js again" — its own words). With all
five `World` methods now wired, this was the natural next step:
`replayEvent(e)` in office.html matches `e.a.agent`/`e.b.agent` against
the live `agents` array by name, and if both are on screen and idle,
dispatches to the right `World` method by `e.resolution.kind`
(`read-yield→yield`, `share→highfive`, `wait→handshake`,
`abort→shove(holder, requester)`, `redundant→doubletake`). If either
agent isn't currently spawned (true for every live-sourced event today,
see the caveat below — `toReelEvent` leaves `a` blank), it still captions
who it was and stops there rather than guessing. Convention documented in
a comment: for the asymmetric beats, `a` is "the one who stands down",
matching `toReelEvent`'s own convention that `b` is always the lease
holder. For generated events there's no real winner encoded on the wire,
so that assignment is arbitrary there — fine for a demo click, not a
factual claim.

**One real gap found, not fixed, filed instead:**
[#60](https://github.com/mohsensc/sync/issues/60) — a live rung-3 contest
resolving for real does not play handshake/shove today. `onLivePresence`
still just calls `world.resolveContest()` on the encounter and drops both
agents to idle. The decision that would explain *why* (the same
`negotiate`/`claim_result` frames now feeding the reel) only reaches the
reel panel, not the scene, because those frames don't carry the
requester's own agent/human identity — there's no clean way today to
match an incoming decision frame back to a specific live `encounters`
pair and know which side is "self" without either client-side bookkeeping
of your own last claim, or a relay-side change to include the requester's
identity on those frames. Wrote up both options in the issue. Not a small
fix, didn't attempt it this round — generated/demo replay through the
reel already exercises all five beats end to end, so this doesn't block
looking at the feature, it just means a *real* relay run's contests
resolve silently in the 3D scene (the reel still shows the truth).

**Small fixes along the way:**
- Reel's human `<select>` had no `name`/`id`/label — devtools flagged it
  as an a11y issue (`msgid 876` in the first console check). Added
  `name="reel-human" aria-label="filter by human"`.
- Nothing else needed fixing — no dead imports, no duplicated helpers
  found. Four builders, clean tree.

**Browser-verified**, shared lock/port/tab, `office.html` under the
running demo (relay unreachable → demo fallback, as expected with no
relay process running):
- Screenshot: scene renders (15/15 objects), reel panel shows 37/37
  events, readable over the busy 3D background, rung chips and human
  filter present and functional (unchanged from task 1's verification).
- Clicked reel rows of every resolution kind with a real DOM click
  (not just console API calls) and confirmed via `window.__world` /
  `window.__agents` (both already exposed by office.html) that each
  produces a live encounter and completes cleanly:
  - `share` (R2) → `world.highfive` — confirmed via debug hook mid-flight
    (`created:true`, both agents busy, then back to idle).
  - `wait` (R3) → `world.handshake` — confirmed via direct console call
    (`created:true`); real-click path shares the same code, not
    separately re-verified after removing the debug hook.
  - `abort` (R3) → `world.shove` — clicked, zero console errors, agents
    resolved without incident.
  - `read-yield` (R1) → `world.yield` — same.
  - `redundant` (R4) → `world.doubletake` — same, plus a direct console
    call earlier in the session confirming the encounter completes and
    both agents return to idle (`activity:'idle'`, `busy:false`).
  - `console` stayed clean throughout — only the two known/expected
    warnings (relay `ERR_CONNECTION_REFUSED`, three `coffee-cup-v2.glb`
    404s, #59) plus, before the fix above, the one a11y notice.
- One thing worth knowing for next round: agents that are mid-demo-beat
  (walking, reading, already paired) are `busy` and a reel click on them
  silently no-ops past the caption — correct behavior, not a bug, but if
  a future round wants every click to *guarantee* a visible beat, it'd
  need to either queue the replay or pull two agents out of the demo's
  own choreography first. Didn't do either; "some clicks land, some just
  caption" reads as acceptable given the panel is explicit about being a
  demo.

`pnpm test` — 89/89 (unchanged; no new tests added this round, this was
integration/wiring, not new logic — the wiring itself is exercised by the
existing `office-reel`/`office-live-decisions`/`office-clips-geometry`
suites plus the manual browser pass above). `pnpm typecheck` — clean.

**Filed:** [#60](https://github.com/mohsensc/sync/issues/60) — live
contest resolution doesn't drive the actual beat (see above).

**Not touched / left alone:** `go/`, `python/`, everything under
`web/src/office/clips/*.js` and `*-test.html` (no clip authoring this
round, just wiring). `README.md` in `web/src/office/` is stale (predates
the whole reel/clips/live-decision system, still describes an
eight-character static scene) — didn't rewrite it, wasn't blocking
anything and a real rewrite deserves its own pass rather than a rushed
addendum. `web/pnpm-workspace.yaml` is untracked in this worktree
(created by `pnpm approve-builds esbuild`, per round 1's setup note) —
left it untracked like round 1 did; it's local toolchain config, not
feature code.

**What's next:**
1. #60 — real live contest resolution. Needs either client-side
   "remember my last claim attempt" bookkeeping or a relay change.
   Bigger than a wiring pass; scope it properly before starting.
2. `README.md` rewrite for `web/src/office/` — it's lying about what's in
   the directory now. Not urgent, but the next person who reads it first
   will be misled.
3. Rung 2's "collaboration" beat still only has one real candidate
   (`world.highfive` via `share`). The chest-bump alternative
   (`clips/social.js`) mentioned in round 1's scoping notes has still
   never shown up in this tree — if it lands from wherever it's supposed
   to come from, rung 2 has a choice to make; until then highfive is it,
   and that's fine.
4. Nothing in this round touched contest→resolution transition *timing*
   or *visual polish* (windup/anticipation/follow-through beyond what
   each clip's own author already tuned) — that's still open ground for
   a round that wants to spend a full session on animation feel rather
   than plumbing.
5. Consider whether `replayEvent`'s silent no-op on busy agents needs a
   caption-level "can't replay right now" instead of a plain caption with
   no visible beat — low priority, flagged above, not done.

## Round 4, task 4 — reel panel v2 (detail, now-playing, arrivals, long lists)

No browser this task (scoped that way — see below for what still needs
eyes). Owned `web/src/office/reel.js`, `reel.d.ts`,
`web/test/office-reel.test.ts`, and only the `#reel`/`.reel-*` CSS rules in
`office.html`'s `<style>` block. Did not touch `agent.js`, `live.js`,
`clips/*`, or any JS in `office.html` — those were locked to tasks 1-3 this
round, working concurrently in this same worktree (their in-progress,
uncommitted edits to `live.js`/`agent.js`/`office.html`'s JS were sitting in
the working tree while this was being built; staged and committed only the
CSS hunk of `office.html` via a hand-picked patch, left the rest of the
file exactly as the other tasks had it — checked with `git diff --cached`
before committing, not just assumed).

**Behavior change, flagged loudly because it changes what round 3 verified:**
clicking a reel row **no longer replays immediately.** It opens/closes an
inline detail card instead. The detail card has an explicit "▶ replay"
button that's the only thing calling `onSelect` — that's what the brief for
this round asked for ("an explicit replay affordance that fires the same
onSelect, so task 2's work stays the single playback entry point"). The
`onSelect` contract itself (`(event) => void`, called with the full reel
event) is unchanged, so whatever task 2 built against it this round should
still work — just triggered by the new button, not a bare row click.
Round 3's "clicked reel rows of every kind" verification predates this and
is now describing dead UX; the next browser pass should re-click through
all five resolution kinds against the new detail-card flow, not just trust
that old verification still applies.

**What's in `reel.js` now**, all in `ReelStore` (pure, no DOM) plus a
render layer that consumes it:

- **Detail toggle** — `toggleOpen(id)`/`openId`/`closeOpen()`. One row open
  at a time (opening a second closes the first). The detail card shows the
  full untruncated path, a plain-English one-line rung explanation
  (`RUNG_EXPLAIN`, e.g. "both wanted the same piece of relay.go —
  contested" — written off the file path since the event shape has no
  symbol field, not a literal echo of the brief's `parseConfig` example),
  the full resolution phrase including `detail` if present, the source tag
  again (never buried), and the replay button.
- **Now-playing state** — `setPlaying(id)`/`clearPlaying()`/`playingId` on
  the store, and `setPlaying`/`clearPlaying` exposed on the object
  `mountReel()` returns, since replay is async and the caller (task 2's
  replay dispatch) needs to set this when a beat starts and clear it when
  it ends. Visual: a pulsing mustard left-edge bar on the row
  (`prefers-reduced-motion` respected — pulse only runs under
  `no-preference`), and the row's replay button reads "playing…" and
  disables itself while its own event is the one playing.
- **Long-list handling** — `page()` returns `{shown, remaining}` capped at
  40 (`REVEAL_STEP`), with `showMore(step)` to raise the cap. Changing
  either filter resets the cap back to 40 — a freshly filtered list starts
  capped, doesn't inherit how far a different list had been expanded. The
  panel renders a "show N older" button under the list when there's a
  remainder.
- **Relative timestamps that don't go stale** — `relTime` is now exported
  (was file-private) so it's directly tested, and the mounted panel runs a
  20s `setInterval` that patches just the `.reel-time` text nodes
  (`retimeOnly()`), not a full re-render — a full render would blow away
  an open detail card or replay an arrival flash every 20 seconds, which
  would be worse than the staleness it's fixing. `mountReel()` now returns
  a `dispose()` that clears the interval, for whoever eventually needs to
  unmount this cleanly.
- **Arrival flash** — `add()` queues live-sourced (not generated/seed) ids
  into an internal list; `takeNewLiveIds()` drains it. The render layer
  calls this once per `render()` and applies a one-shot CSS flash
  (`.reel-row-new`, a soft green wash fading over 1.6s — the same green as
  the `live` source tag, so the flash reads as "this just arrived for
  real," not just "something changed"). Consumed once: a live row that
  flashed on arrival won't flash again on a later filter-triggered
  re-render.
- **Keyboard focus** — rows are `role="button" tabindex="0"` with
  Enter/Space wired to the same toggle as a click (rows are no longer
  `<button>` elements themselves, because the detail card's replay button
  can't legally nest inside one — restructured to a wrapping `.reel-item`
  div with a focusable `.reel-row` inside it, mirroring how a disclosure
  widget is normally built). `:focus-visible` outlines added for rows,
  chips, the human select, the replay button, and the "show older" button
  — none of the interactive reel elements had a visible focus state
  before this.

**Tests**: 22 new cases in `office-reel.test.ts` (open/close/switch-row
toggle, now-playing set/clear, reveal cap/showMore/reset-on-filter-change,
arrival marking including "consumes the queue" and "accumulates between
takes," and `relTime`'s bucket boundaries at 5s/1m/1h/1d plus a
future-timestamp guard). `pnpm test` — 111/111 in this file's own run
(127 when run alongside tasks 1-3's concurrent in-progress work in the
same tree, all green). `pnpm typecheck` — clean.

**What still needs eyes in a browser, explicitly, since this task was
scoped no-browser:**
- The detail card's actual layout/spacing at 308px panel width — sized it
  off the existing `.reel-body`/`.reel-line2` measurements but never
  rendered it.
- The arrival flash color/duration and the now-playing pulse, live, not
  just read as CSS.
- Whether the new row structure (div-based `.reel-row` inside `.reel-item`
  instead of a bare `<button>`) still hovers/clicks the same as before —
  should be identical since the CSS selectors didn't change shape, but
  "should be identical" isn't "confirmed."
- The `retimeOnly()` 20s interval doing the right thing over a longer
  session (i.e. not drifting, not double-firing) — only reasoned through,
  never run.
- Keyboard-only navigation through the whole panel (Tab through chips,
  human select, rows, replay button, show-older button) — the CSS is
  there but never tabbed through by hand.

Whoever does that pass: this doesn't need a dedicated round, task 2's
existing replay screenshots plus five minutes of clicking through detail
cards and the reveal button should cover it.

Not touched: `agent.js`, `live.js`, `live.d.ts`, `clips/*`,
`office-live*.test.ts`, `office-clips-geometry.test.ts` — other tasks'
files and tests this round, left alone. No issue filed this task — nothing
hit was expensive enough to defer; the row-click behavior change is a
deliberate spec change, not an edge case being punted.
