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
