# Office scene

A Three.js view of the room. Characters are one rigged clay mesh cloned per agent.
The GLB ships no usable motion, so every clip is authored from keyframe tracks.

## What's in here

- `anim.js` — nine procedural clips against the rig's 24 bones (`BIND` has the
  full table). Mixamo naming, root `Hips`; spine chain is inverted
  (`Hips > Spine02 > Spine01 > Spine > neck > Head`, Spine02 is the belly).
- `highfive.js`, `handshake.js`, `clips/argue.js` — paired-agent routines, each
  with its own `*-test.html` harness.
- `agent.js` — `Agent` (activity machine plus steering) and `World` (owns
  agents, brokers paired actions). `createAgent()` is the contract everything
  else uses.
- `zones.js` — 10 named floor regions anchored to real props; `zoneFor(verb,
  path)` maps agent work to a zone.
- `interact.js` — click to select, click floor/desk to send/sit, hover to
  highlight, desk-ownership tint (T toggles steady/breathe wash).
- `demo.js` — `runDemo(ctx)`, scripted fallback when the relay is unreachable.
- `live.js` — relay connection and `LiveDirector`: presence frame -> zone,
  slot, rung-3 contest pairing. Pure logic, no THREE.
- `dressing.js` — set dressing for zones with no generated prop.
- `../../gitapi.mjs` (web root) — dev-only `/api/git/*` endpoints
  (stat/blame/log/shortlog/churn), real `git` shelled out server-side. Never
  reachable outside `pnpm dev`.
- `history-viz.js` — pure helpers shared by every git-data panel: author ->
  colour hash, relative-age parsing, age-to-axis-position.
- `blamecard.js` — DOM panel on click-to-zoom: ownership bar + commit
  timeline (V toggles graphic/classic variant).
- `gitsignals.js` — ambient per-zone polling off `/api/git/stat` +
  `/api/git/churn` (typing speed, desk paper stacks).
- `histshelf.js` — the selected agent's file history as a floating shelf of
  book spines (B toggles 3D spines / DOM film-strip); degrades to a single
  dusty tome at 0-1 commits, nothing at all with no history.

## Two traps

Clone skinned meshes with `SkeletonUtils.clone`, not `.clone()` — a shared
skeleton collapses every copy onto the original. Call `updateMatrixWorld(true)`
before measuring a clone with `Box3`, or a stale skeleton reads near-zero and
the scale explodes to ~99x. Yaw at the module boundary is EXTERNAL
(`atan2(-dx, -dz)`); the rig faces +Z, `agent.js` absorbs the gap with
`YAW_OFFSET = PI`.

## Test pages

One `*-test.html` fixture harness per major piece (`anim-test`, `highfive-test`,
`blamecard-test`, `histshelf-test`, ...) — canned data, no dev server needed
for the git-data ones. `office.html` itself needs `pnpm dev` and a browser.
