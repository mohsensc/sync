# Office scene

A Three.js view of the room. Characters are one rigged clay mesh cloned per agent.
The GLB ships no usable motion, so every clip is authored from keyframe tracks.

## What's in here

- `anim.js` — procedural clips against the rig's 24 bones (`BIND` has the table).
  Mixamo naming, root `Hips`, spine inverted (Spine02 is the belly). `crossfade`
  owns every weight on the mixer, so clips built elsewhere come in through
  `crossfadeAction`. `setSeed` varies idle/walk per agent, `popMetric` scores it.
- `highfive.js`, `handshake.js`, `clips/*.js` — paired-agent routines, one per
  ladder beat and its variants, each with a `*-test.html` harness.
- `agent.js` — `Agent` (activity machine plus steering) and `World` (owns agents,
  brokers paired actions); `createAgent()` is the contract everything else uses.
- `zones.js` — 10 floor regions anchored to props; `zoneFor(verb, path)`.
- `interact.js` — click to select/send/sit, hover to highlight (H), desk tint (T).
- `demo.js` — `runDemo(ctx)`, scripted fallback for when the relay's unreachable.
- `live.js` — relay connection and `LiveDirector`: presence frame -> zone, slot,
  contest pairing, optional line-range (`regionFromMsg`). No THREE.
- `dressing.js` — set dressing for zones with no generated prop.
- `caption.js` — one arbiter over the caption so replay and demo can't clobber it.
- `../../gitapi.mjs` (web root) — dev-only `/api/git/*`, real `git` shelled
  server-side, never reachable outside `pnpm dev`.
- `history-viz.js` — pure helpers every git-data panel shares (colour, age, axis).
- `blamecard.js` — panel on click-to-zoom: ownership bar + commit timeline.
- `gitsignals.js` — ambient per-zone git stat/churn polling (typing, paper stacks).
- `histshelf.js` — selected agent's file history as book spines (B: 3D/DOM).
- `zoneowner.js` — per-zone `git shortlog` as dressing: plaque or rug (U).
- `ghost.js` — who wrote the lines an agent stands in, as a figure by the desk (G).
  Argues or shakes hands if that author is in the room.
- `reel.js`, `replay-card.js`, `seed.js` — the highlight reel: clashes ranked and
  filterable, click a row to replay the beat in-scene.
- `../../scripts/optimize-glb.mjs` — gltf-transform, `public/glb/` -> `glb-lite/`,
  the only path the scene loads. Skin kept, never quantized, `EXT_texture_webp`.

## Traps

Clone skinned meshes with `SkeletonUtils.clone`, not `.clone()` — a shared skeleton
collapses every copy onto the original. Call `updateMatrixWorld(true)` before
measuring a clone with `Box3`, or a stale skeleton reads near-zero and blows up ~99x.
Yaw at the module boundary is EXTERNAL (`atan2(-dx, -dz)`); the rig faces +Z and
`agent.js` absorbs the gap with `YAW_OFFSET = PI`. Shadows are PCF at 1024 — the one
type reading `shadow.radius` — and a prop casts (`cast:true`) only if it'd float.

## Test pages

One `*-test.html` harness per major piece — canned data, no dev server needed for
the git-data ones. `office.html` needs `pnpm dev` and `?room=<name>` for a relay.
