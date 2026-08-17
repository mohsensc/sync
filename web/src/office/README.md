# Office scene

A Three.js view of the room. Characters are one rigged clay mesh cloned per agent.
The GLB ships no usable motion, so every clip is authored from keyframe tracks.

## What's in here

- `anim.js` — procedural clips against the rig's 24 bones (`BIND` has the table).
  Mixamo naming, root `Hips`, spine inverted (Spine02 is the belly).
- `highfive.js`, `handshake.js`, `clips/*.js` — paired-agent routines, one per
  ladder beat and its variants, each with a `*-test.html` harness.
- `agent.js` — `Agent` (activity machine plus steering) and `World` (owns agents,
  brokers paired actions); `createAgent()` is the contract everything else uses.
- `zones.js` — 10 floor regions anchored to props; `zoneFor(verb, path)`.
- `interact.js` — click to select/send/sit, hover to highlight (H), desk tint (T).
- `demo.js` — `runDemo(ctx)`, scripted fallback when the relay is unreachable.
  Its cast carries real git line-ranges for region blame (`REGIONS`).
- `live.js` — relay connection and `LiveDirector`: presence frame -> zone, slot,
  contest pairing, optional line-range (`regionFromMsg`). No THREE.
- `dressing.js` — set dressing for zones with no generated prop.
- `caption.js` — one arbiter over the bottom caption, so a replay's line can't
  be clobbered by the demo's.
- `../../gitapi.mjs` (web root) — dev-only `/api/git/*`, real `git` shelled
  server-side, never reachable outside `pnpm dev`.
- `history-viz.js` — pure helpers every git-data panel shares: author -> colour,
  relative-age parsing, age-to-axis-position.
- `blamecard.js` — panel on click-to-zoom: ownership bar + commit timeline
  (V: graphic/classic; R: region/whole-file when in range).
- `gitsignals.js` — ambient per-zone `/api/git/stat` + `churn` polling (typing
  speed, paper stacks); exports `ZONE_DIRS`.
- `histshelf.js` — selected agent's file history as book spines (B: 3D/DOM).
- `zoneowner.js` — per-zone `git shortlog` as dressing: plaque or rug (U).
- `ghost.js` — who wrote the lines an agent stands in, as a translucent figure
  beside the desk (G). Argues or shakes hands if that author is in the room.
- `reel.js`, `replay-card.js`, `seed.js` — the highlight reel: every clash
  ranked and filterable, click a row to replay the beat in-scene.

## Two traps

Clone skinned meshes with `SkeletonUtils.clone`, not `.clone()` — a shared
skeleton collapses every copy onto the original. Call `updateMatrixWorld(true)`
before measuring a clone with `Box3`, or a stale skeleton reads near-zero and
explodes to ~99x. Yaw at the module boundary is EXTERNAL (`atan2(-dx, -dz)`);
the rig faces +Z, `agent.js` absorbs the gap with `YAW_OFFSET = PI`.

## Test pages

One `*-test.html` harness per major piece — canned data, no dev server needed
for the git-data ones. `office.html` needs `pnpm dev`, a browser, and
`?room=<name>` to reach a relay at all.
