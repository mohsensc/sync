# Office scene

A Three.js view of the room. Characters are one rigged clay mesh cloned per agent;
props are static meshes. Nothing here is generated at runtime.

## What's in here

- `anim.js` — procedural animation clips built against the rig's 24 bones. The GLB
  ships no usable motion (its one clip is a bind-pose snapshot), so every clip is
  authored from keyframe tracks.
- `anim-test.html` — one character, a button per clip. Use this to judge a clip.
- `office.html` — the room, props and characters.

## Rig

Standard Mixamo naming, root is `Hips`:

    Hips
    LeftUpLeg > LeftLeg > LeftFoot > LeftToeBase
    RightUpLeg > RightLeg > RightFoot > RightToeBase
    Spine > Spine01 > Spine02
    LeftShoulder > LeftArm > LeftForeArm > LeftHand
    RightShoulder > RightArm > RightForeArm > RightHand
    neck > Head > head_end, headfront

## Two traps

Clone skinned meshes with `SkeletonUtils.clone`, not `.clone()` — a shared skeleton
collapses every copy onto the original. And call `updateMatrixWorld(true)` before
measuring a clone with `Box3`; a stale skeleton reports a near-zero height, so any
`targetHeight / size.y` scale explodes to about 99x.

## What's broken

- The high-five contact isn't settled. `ik.js` solves two-bone IK so the hands meet
  at any spacing, but that's the wrong primitive here: the controller owns the
  pathing, so both characters can just walk to fixed marks and play a clip authored
  for that exact distance. Marks should replace the solver; keep IK only if a small
  corrective blend earns its place.
- `office.html` never imported `anim.js`, so every character in the room stands in
  the bind T-pose. The clips work; the room just doesn't play them yet.
- Palm aiming solves for the closest reachable direction, and on a couple of poses
  the closest is not the one asked for — `sit` ends about 25 degrees off palm-down
  because a forearm sloping down the thigh cannot get there. Everything else lands
  inside 20.
- Interactivity (click to select, click to send, zone routing, demo mode) was
  started and isn't in this branch.

Desk height: fixed. desk-tripo-12k.glb has a raised back lip above the actual
worksurface, so `office.html` scales off `DESK_SURFACE_RAW` (0.536, measured by
raycasting the top face) instead of total bbox height. Surface lands at exactly
0.74m for regular desks, 0.95m for the reception counter, against a 1.68m
character — verified in-browser, screenshot in the PR. See `place()`'s
`surfaceRaw` handling.
