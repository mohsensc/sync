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

- Hand rotation reads wrong through the wrist on several clips.
- The paired high-five doesn't land — the two hands don't actually meet.
- Desk height is off against a 1.68m character.
