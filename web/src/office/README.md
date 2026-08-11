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

`agent.js`'s `World.highfive` now goes through `highfive.js`'s `highfiveMarks()`
too — one lineage, not two. Checked in the office scene itself (not just the
test page): two different starting positions both landed the palm centres
under 1.1mm apart at the contact frame (0.5mm and 1.0mm), wrists about 5-6cm
apart, which is the expected offset for a bone that sits at the wrist while the
palm reaches past it.

Desk surface at 0.74m, counter at 0.95m. `desk-tripo-12k.glb` has a raised back
lip, so `place()` scales off `DESK_SURFACE_RAW` (0.536), not total bbox height —
that leaves the bbox top at 0.763. On a 1.68m character the hip is at 0.698, so
the surface sits 4cm above it.

## Interactivity

`office.html` loads the room, then:

- `zones.js` — 10 named floor regions anchored to real props, with standing slots
  agents claim. `zoneFor(verb, path)` maps agent work to a zone.
- `agent.js` — `Agent` (activity machine plus steering) and `World` (owns agents,
  brokers paired actions). `createAgent()` is the contract everything else uses.
- `interact.js` — click to select, click the floor to send, click a desk to sit and
  type, hover to highlight.
- `demo.js` — `runDemo(ctx)`, six captioned beats, cancellable and replayable.
- `dressing.js` — set dressing for the zones with no generated prop.

Yaw convention at the boundary is EXTERNAL (`atan2(-dx, -dz)`), not the rig's. The
rig faces +Z; `agent.js` absorbs the difference with `YAW_OFFSET = PI`. If you touch
yaw anywhere, use the external convention.

The spine chain is inverted from what you would guess: `Hips > Spine02 > Spine01 >
Spine > neck > Head`. Spine02 is the belly, Spine is the chest.
