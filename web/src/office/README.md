# Office scene

A Three.js view of the room. Characters are one rigged clay mesh cloned per agent.
The GLB ships no usable motion, so every clip is authored from keyframe tracks.

## What's in here

- `anim.js` — nine procedural clips against the rig's 24 bones (`BIND` has
  the full table). Mixamo naming, root `Hips`, spine chain inverted (Spine02
  is the belly).
- `highfive.js`, `handshake.js`, `clips/argue.js` — paired-agent routines,
  each with its own `*-test.html` harness.
- `agent.js` — `Agent` (activity machine plus steering) and `World` (owns
  agents, brokers paired actions); `createAgent()` is the contract everything
  else uses.
- `zones.js` — 10 named floor regions anchored to real props; `zoneFor(verb,
  path)` maps agent work to a zone.
- `interact.js` — click to select/send/sit, hover to highlight (H: card/
  nameplate/rich), desk-ownership tint (T: steady/breathe).
- `demo.js` — `runDemo(ctx)`, scripted fallback when the relay is unreachable.
  Cast carries real git line-ranges for the region-blame view (`REGIONS`).
- `live.js` — relay connection and `LiveDirector`: presence frame -> zone,
  slot, contest pairing, optional line-range (`regionFromMsg`). No THREE.
- `dressing.js` — set dressing for zones with no generated prop.
- `../../gitapi.mjs` (web root) — dev-only `/api/git/*`, real `git` shelled
  server-side, never reachable outside `pnpm dev`.
- `history-viz.js` — pure helpers shared by every git-data panel: author ->
  colour hash, relative-age parsing, age-to-axis-position.
- `blamecard.js` — DOM panel on click-to-zoom: ownership bar + commit
  timeline (V: graphic/classic; R: region/whole-file when in range).
- `gitsignals.js` — ambient per-zone polling off `/api/git/stat` +
  `/api/git/churn` (typing speed, paper stacks); exports `ZONE_DIRS`.
- `histshelf.js` — selected agent's file history as a shelf of book spines
  (B: 3D spines / DOM strip); degrades to one dusty tome or nothing.
- `zoneowner.js` — per-zone `git shortlog` as room dressing: plaque or rug
  (U toggles), trophy/mugs for a lopsided/near-even split.

## Two traps

Clone skinned meshes with `SkeletonUtils.clone`, not `.clone()` — a shared
skeleton collapses every copy onto the original. Call `updateMatrixWorld(true)`
before measuring a clone with `Box3`, or a stale skeleton reads near-zero and
explodes to ~99x. Yaw at the module boundary is EXTERNAL (`atan2(-dx, -dz)`);
the rig faces +Z, `agent.js` absorbs the gap with `YAW_OFFSET = PI`.

## Test pages

One `*-test.html` fixture harness per major piece (`anim-test`, `blamecard-test`,
`histshelf-test`, `zoneowner-test`, ...) — canned data, no dev server needed
for the git-data ones. `office.html` itself needs `pnpm dev` and a browser.
