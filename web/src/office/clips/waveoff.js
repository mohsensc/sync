// Wave-off: an alternate rung-3 "abort" beat, alongside shove.js and
// slap.js. Quieter than either — the winner doesn't even bother squaring up,
// just glances back and gives a slow, contemptuous back-of-hand wave without
// fully turning around, like shooing off something not worth the trouble.
// The loser gets the message: shoulders drop, head goes down, a small
// shuffle-step back. No contact anywhere in this one — the meanness is in
// how little effort the winner spends on it.
//
// PAIRED ACTION, BUT NOT A CONTACT ONE — same category as clips/argue.js:
// nobody touches, so there's no measured contact point to derive a spacing
// from. The distance is chosen directly (see WAVEOFF_SPACING below), a
// touch further apart than shove/slap's contact-fitted numbers, because
// "not bothering to close the distance" is part of the gesture.
//
// Still asymmetric like shove.js — two different bodies doing two different
// things, `a` always the winner — so this exports two clips (`waveoff`,
// `waveoffReact`), same duration, started the same frame.
//
// This file duplicates shove.js's scratch-rig/clip-builder boilerplate for
// the same reason every paired-action file in this codebase does: see
// shove.js's own header note on why that plumbing isn't shared.
//
// No IK anywhere. See the office README's note at the bottom.

import * as THREE from 'three'
import * as ANIM from '../anim.js'
import { highfiveMarks, palmPoint, handPoint, CHARACTER_HEIGHT } from '../highfive.js'

const clamp01 = u => Math.max(0, Math.min(1, u))
const smooth = u => u * u * (3 - 2 * u)

// ---------------------------------------------------------------------------
// Scratch rig — identical scaffold to shove.js's own copy.
// ---------------------------------------------------------------------------
const PARENT = {
  Hips: null,
  Spine02: 'Hips', Spine01: 'Spine02', Spine: 'Spine01', neck: 'Spine', Head: 'neck',
  LeftShoulder: 'Spine', LeftArm: 'LeftShoulder', LeftForeArm: 'LeftArm', LeftHand: 'LeftForeArm',
  RightShoulder: 'Spine', RightArm: 'RightShoulder', RightForeArm: 'RightArm', RightHand: 'RightForeArm',
  LeftUpLeg: 'Hips', LeftLeg: 'LeftUpLeg', LeftFoot: 'LeftLeg', LeftToeBase: 'LeftFoot',
  RightUpLeg: 'Hips', RightLeg: 'RightUpLeg', RightFoot: 'RightLeg', RightToeBase: 'RightFoot',
}

function makeRig() {
  const bones = {}
  for (const name of ANIM.BONES) {
    const o = new THREE.Object3D()
    o.name = name
    const bd = ANIM.BIND[name]
    o.position.set(bd.t[0], bd.t[1], bd.t[2])
    o.quaternion.set(bd.q[0], bd.q[1], bd.q[2], bd.q[3])
    bones[name] = o
  }
  for (const name of ANIM.BONES) { const p = PARENT[name]; if (p) bones[p].add(bones[name]) }
  bones.Hips.updateMatrixWorld(true)
  return bones
}


// ---------------------------------------------------------------------------
// Pose authoring
// ---------------------------------------------------------------------------
function lerpPose(a, b, u) {
  const o = {}
  for (const k in a) {
    const av = a[k], bv = b[k] || av
    o[k] = av.map((v, i) => v + ((bv[i] ?? v) - v) * u)
  }
  return o
}

function rightArm(shY, shZ, armX, armY, armZ, elbow, flex, dev, palm) {
  return {
    RightShoulder: [0, shY, shZ],
    RightArm: [armX, armY, armZ],
    RightForeArm: [0, elbow, 0],
    RightHand: [flex, dev, 0],
    RightPalm: palm,
  }
}

/** Unlike shove.js/slap.js, this pose fragment is deliberately NOT mirrored
 *  onto the left arm — a one-armed dismissive wave loses its whole character
 *  if the other arm mirrors along with it. The left arm is authored
 *  separately per milestone (usually just resting). */
function milestone({ hips = [0, 0, 0], Hips = [0, 0, 0], lean = 0, twist = 0, nod = 0, tilt = 0, ra, la, legs = {} }) {
  return {
    hips, Hips,
    Spine02: [lean * 0.45, twist * 0.34, 0],
    Spine01: [lean * 0.30, twist * 0.33, 0],
    Spine: [lean * 0.25, twist * 0.33, 0],
    neck: [nod * 0.4, -twist * 0.30, 0],
    Head: [nod, -twist * 0.60, tilt],
    ...ra, ...la,
    LeftUpLeg: legs.up || [0, 0, 0], RightUpLeg: legs.up || [0, 0, 0],
    LeftLeg: legs.knee || [0, 0, 0], RightLeg: legs.knee || [0, 0, 0],
    LeftFoot: [0, 0, 0], RightFoot: [0, 0, 0], LeftToeBase: [0, 0, 0], RightToeBase: [0, 0, 0],
  }
}

function leftArm(shY, shZ, armX, armY, armZ, elbow, flex, dev, palm) {
  return {
    LeftShoulder: [0, -shY, -shZ],
    LeftArm: [armX, -armY, -armZ],
    LeftForeArm: [0, -elbow, 0],
    LeftHand: [flex, -dev, 0],
    LeftPalm: [-palm[0], palm[1], palm[2]],
  }
}

const REST_R = rightArm(0, 2, -4, 8, 99, 16, 5, 4, [1, -0.05, -0.32])
const REST_L = leftArm(0, 2, -4, 8, 99, 16, 5, 4, [1, -0.05, -0.32])
const REST_ARM = { ra: REST_R, la: REST_L }

// ---------------------------------------------------------------------------
// waveoff — the winner
// ---------------------------------------------------------------------------
// rest -> GLANCE (barely turns — a small negative twist takes the torso
// AWAY from the partner, not toward, while the head cranes back over the
// shoulder for a look; the right arm lifts to chest height, hand loosely
// cocked, back of the hand leading) -> the SWEEP itself, a slow lateral
// backhand "shoo" arc, held a beat at the far end so it reads as deliberate
// rather than a twitch -> RETURN, the arm drops as the winner finishes
// turning away, twist deepening — by the end the winner is basically
// already facing off toward wherever they were headed, having spent the
// absolute minimum of themselves on this. Slow throughout: the contempt is
// in not hurrying.
const WO_GLANCE_T = 0.22
const WO_SWEEP_OUT_T = 0.55
const WO_HOLD_T = 0.72
export const WAVEOFF_PEAK_T = WO_SWEEP_OUT_T   // the "peak pose" — full sweep
const WO_DUR = 1.95

const GLANCE = milestone({
  lean: -3, nod: -8, twist: -14, tilt: 6,
  ra: rightArm(-6, 12, -18, 30, 60, 44, -4, 6, [0.35, 0.1, 0.5]),
  la: REST_L,
})
const SWEEP = milestone({
  lean: -4, nod: -10, twist: -20, tilt: 10,
  ra: rightArm(2, 34, -10, 78, 42, 30, 8, -10, [0.6, -0.5, 0.2]),
  la: REST_L,
})
const RETURN = milestone({
  lean: 2, nod: -4, twist: -34, tilt: 2,
  ra: rightArm(-4, 4, -8, 10, 92, 18, 5, 4, [0.9, -0.1, -0.2]),
  la: REST_L,
})

const WO_SEGS = [
  [WO_GLANCE_T, milestone({ ...REST_ARM }), GLANCE, smooth],
  // the sweep itself: unhurried, a single lazy arc.
  [WO_SWEEP_OUT_T, GLANCE, SWEEP, smooth],
  // hold at the peak of the wave — the "I can't be bothered" beat.
  [WO_HOLD_T, SWEEP, SWEEP, u => u],
  [1.00, SWEEP, RETURN, smooth],
]

function woBlend(t) {
  let i = 0, t0 = 0
  while (i < WO_SEGS.length - 1 && t >= WO_SEGS[i][0]) { t0 = WO_SEGS[i][0]; i++ }
  const [t1, from, to, easing] = WO_SEGS[i]
  const u = easing(clamp01(t1 === t0 ? 1 : (t - t0) / (t1 - t0)))
  return lerpPose(from, to, u)
}

function waveoffPose(t) {
  return { ...ANIM.STANDING, ...woBlend(t) }
}

// ---------------------------------------------------------------------------
// waveoffReact — the loser
// ---------------------------------------------------------------------------
// rest, held through the winner's glance -> DEFLATE, starting as soon as the
// sweep begins: shoulders drop (a negative shoulder-Y roll reads as a slump
// on this rig), spine curls forward slightly, head drops, no anger left in
// it, just resignation -> SHUFFLE, a small step back (much smaller than
// shove's stagger — this isn't knocked back, it's backing off) that lands
// and settles right as the winner's RETURN finishes -> holds deflated.
const RE_DEFLATE_T = 0.55
const RE_SHUFFLE_T = 0.85
const SHUFFLE_CM = 16   // a step back, not a stumble — see shove.js's STEP_BACK_CM for contrast

const REST_POSE = milestone({ ...REST_ARM })
const DEFLATE = milestone({
  lean: 10, nod: 16, twist: 4,
  ra: rightArm(-16, 6, -6, 4, 100, 14, 6, 3, [0.7, -0.3, -0.15]),
  la: leftArm(-16, 6, -6, 4, 100, 14, 6, 3, [0.7, -0.3, -0.15]),
})
const SHUFFLE = milestone({
  lean: 12, nod: 20, twist: 2,
  hips: [0, -1, -SHUFFLE_CM],
  legs: { up: [-4, 1, 1], knee: [8, 0, 0] },
  ra: rightArm(-18, 6, -6, 4, 100, 14, 6, 3, [0.7, -0.3, -0.15]),
  la: leftArm(-18, 6, -6, 4, 100, 14, 6, 3, [0.7, -0.3, -0.15]),
})

const RE_SEGS = [
  [WO_GLANCE_T, REST_POSE, REST_POSE, u => u],
  [RE_DEFLATE_T, REST_POSE, DEFLATE, smooth],
  [RE_SHUFFLE_T, DEFLATE, SHUFFLE, smooth],
  [1.00, SHUFFLE, SHUFFLE, u => u],
]

function reactBlend(t) {
  let i = 0, t0 = 0
  while (i < RE_SEGS.length - 1 && t >= RE_SEGS[i][0]) { t0 = RE_SEGS[i][0]; i++ }
  const [t1, from, to, easing] = RE_SEGS[i]
  const u = easing(clamp01(t1 === t0 ? 1 : (t - t0) / (t1 - t0)))
  return lerpPose(from, to, u)
}

function waveoffReactPose(t) {
  return { ...ANIM.STANDING, ...reactBlend(t) }
}

// ---------------------------------------------------------------------------
// Specs / registry
// ---------------------------------------------------------------------------
// Long and slow relative to shove/slap (1.95s vs 1.65s/1.35s) — the point of
// this beat is that nobody is in a hurry. 56 keys is plenty; nothing here
// moves fast enough to need shove/slap's denser sampling.
const WO_KEYS = 56
export const WAVEOFF_SPEC = { fn: waveoffPose, dur: WO_DUR, keys: WO_KEYS, loop: false }
export const WAVEOFF_REACT_SPEC = { fn: waveoffReactPose, dur: WO_DUR, keys: WO_KEYS, loop: false }

export const registry = { waveoff: WAVEOFF_SPEC, waveoffReact: WAVEOFF_REACT_SPEC }

// Folded into anim.js's own CLIPS table at import time, so these play by name
// through ANIM.crossfade like every other clip — one clip table, one owner of
// the mixer's weights. See anim.js's CLIPS header for the timing rule (the
// merge has to happen before the first createClips(), which import time is).
Object.assign(ANIM.CLIPS, registry)


// ---------------------------------------------------------------------------
// Spacing — chosen directly, same reasoning as argue.js's ARGUE_SPACING:
// there's no contact to measure, so this is a root-to-root distance for a
// CHARACTER_HEIGHT character. Wider than argue's 0.85 (a standoff) and
// wider than shove/slap's contact-fitted spacing — the winner never closes
// the gap for this one, so the marks shouldn't put them close enough to
// look like they were about to.
// ---------------------------------------------------------------------------
export const WAVEOFF_SPACING = 1.05

export function spacingFor(height = CHARACTER_HEIGHT) {
  return WAVEOFF_SPACING * (height / CHARACTER_HEIGHT)
}

/** Where the pair have to stand — same shape as shove.js's shoveMarks. */
export function waveoffMarks(aPos, bPos, spacing = WAVEOFF_SPACING) {
  return highfiveMarks(aPos, bPos, spacing)
}

export { palmPoint, handPoint }

// ---------------------------------------------------------------------------
// Measurement helpers for the harness
// ---------------------------------------------------------------------------
export function boneAt(clipName, t, boneName) {
  const rig = makeRig()
  ANIM.applyPose(rig.Hips, registry[clipName].fn(t))
  const b = rig[boneName]
  b.updateWorldMatrix(true, false)
  return new THREE.Vector3().setFromMatrixPosition(b.matrixWorld)
}
