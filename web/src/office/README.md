# Office scene

A Three.js view of the room. Characters are one rigged clay mesh cloned per agent.
The GLB ships no usable motion, so every clip is authored from keyframe tracks.

## What's in here

- `anim.js` — nine procedural clips against the rig's 24 bones. Poses name the
  direction the palm should face; the forearm roll is solved per frame.
- `highfive.js` — `HIGHFIVE_SPACING`, the marks the pair walk to, and the routine
  that starts both clips on one frame.
- `anim-test.html` — one character, a button per clip.
- `highfive-test.html` — three pairs at random start distances, reporting palm gap.
- `office.html` — the room: props, eight standing characters, and a pair who walk
  onto marks and high five on a loop.

## Rig

24 bones, Mixamo naming, root `Hips`. Legs `UpLeg > Leg > Foot > ToeBase`, spine
`Spine > Spine01 > Spine02` (Spine02 is the lowest), arms `Shoulder > Arm >
ForeArm > Hand`, `neck > Head`. Full table is `BIND` in `anim.js`.

## Two traps

Clone skinned meshes with `SkeletonUtils.clone`, not `.clone()` — a shared skeleton
collapses every copy onto the original. And call `updateMatrixWorld(true)` before
measuring a clone with `Box3`, or a stale skeleton reads near-zero and
`targetHeight / size.y` explodes to about 99x.

## Seen working in a browser

High five contacts wherever the pair start: they walk onto marks (0.908m at a
1.68m character) and both play the same clip, and the palm centres land 0.07mm
apart at contact from both a 2.0m and a 5.4m start. `ik.js` is gone.

Desk surface at 0.74m, counter at 0.95m. `desk-tripo-12k.glb` has a raised back
lip, so `place()` scales off `DESK_SURFACE_RAW` (0.536), not total bbox height —
that leaves the bbox top at 0.763. On a 1.68m character the hip is at 0.698, so
the surface sits 4cm above it.

## What's broken

- No chairs. `sit`, `type` and `sleep` only look right in `anim-test.html`, which
  fakes a desk and a block to sit on. `office.html` uses standing clips only.
- `coffee-cup-v2.glb` has never existed. `office.html` had four entries for it that
  failed every load while the tally counted them as loaded. Both fixed.
- Palm aiming takes the closest reachable direction, not always the one asked for.
  `sit` settles about 25 degrees off palm-down — a forearm sloping down the thigh
  cannot get there. `read` and `type` reach 18 at their extremes; the rest, 8.
- Interactivity (select, send, zone routing, demo mode) isn't in this branch.
