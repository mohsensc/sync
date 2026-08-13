// Shove: the rung-3 "abort" beat. One agent out-authoritied the other — wait-die
// aborted the younger transaction, or a straight priority-tier win — and this is
// what that looks like from across the room. Funny, a little mean, not neutral.
// The winner (`shove`) plants both hands on the loser's chest and drives them
// back; the loser (`shoveReact`) eats it, stumbles a step, and droops.
//
// Same discipline as clips/argue.js and clips/handshake.js:
//
//   1. One canonical spacing, authored from the clip's own contact geometry,
//      not eyeballed. See measureContact() below and CONTACT_Y_CM/CONTACT_Z_CM.
//   2. Marks are the primitive — the controller walks the pair onto the line
//      between them, centred, facing each other, before anything plays.
//   3. Asymmetric pair, like argue: the two sides do different things, so this
//      exports two clips (`shove`, `shoveReact`), authored to the same
//      duration and started the same frame so they read as one event rather
//      than two people flailing independently.
//
// WHY THIS FILE BUILDS ITS OWN CLIPS
// anim.js exports applyPose (which runs the full palm-roll solve) but not the
// internals that turn a pose function into a THREE.AnimationClip. So, same as
// clips/handshake.js and clips/argue.js, this file builds a scratch rig
// straight off anim.js's own BIND data and replays applyPose across it once
// per sample, reading the resulting quaternions into keyframe tracks.
//
// A DELIBERATE RULE BREAK: HIPS TRANSLATION.
// Every other paired clip in this codebase keeps `hips: [0,0,0]` throughout,
// because the feet are children of the hips and dragging the pelvis around
// drags them across the floor with it (see argue.js's and handshake.js's own
// notes on this). The loser's "stagger back a step" is exactly that dragged-
// feet slide, done on purpose: there is no walk-cycle or IK to blend a real
// recovery step out of, and a slide reads, at this distance and this length
// (well under a second), as a stumble rather than a skate. If it ever reads
// as skating instead of stumbling, the fix is a short foot-catch bend partway
// through STAGGER, not backing the translation out.
//
// No IK anywhere. See the note at the bottom of the office README.

import * as THREE from 'three'
import * as ANIM from '../anim.js'
import { highfiveMarks, yawTowards, walkScale, palmPoint, handPoint, CHARACTER_HEIGHT, MODEL_HEIGHT_CM } from '../highfive.js'

const TAU = Math.PI * 2
const clamp01 = u => Math.max(0, Math.min(1, u))
const smooth = u => u * u * (3 - 2 * u)

// ---------------------------------------------------------------------------
// Scratch rig — identical scaffold to handshake.js/argue.js's own copies.
// anim.js doesn't export the bone hierarchy, so each of these files builds
// its own from anim.js's flat BIND table plus the topology documented in
// anim.js's header ("Spine chain is INVERTED: Hips > Spine02 > Spine01 >
// Spine > neck > Head").
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

/** Build a THREE.AnimationClip from a {fn, dur, keys, loop} spec — the same
 *  shape anim.js's own CLIPS table uses. */
function buildClipFromSpec(name, { fn, dur, keys, loop }) {
  const n = loop ? keys + 1 : keys
  const times = new Float32Array(n)
  const rot = {}
  for (const b of ANIM.BONES) rot[b] = new Float32Array(n * 4)
  const hips = new Float32Array(n * 3)
  const rig = makeRig()

  for (let i = 0; i < n; i++) {
    const t01 = loop ? i / keys : (n === 1 ? 0 : i / (n - 1))
    times[i] = t01 * dur
    ANIM.applyPose(rig.Hips, fn(t01))
    for (const b of ANIM.BONES) {
      const bone = rig[b]
      rot[b][i * 4 + 0] = bone.quaternion.x
      rot[b][i * 4 + 1] = bone.quaternion.y
      rot[b][i * 4 + 2] = bone.quaternion.z
      rot[b][i * 4 + 3] = bone.quaternion.w
    }
    hips[i * 3 + 0] = rig.Hips.position.x
    hips[i * 3 + 1] = rig.Hips.position.y
    hips[i * 3 + 2] = rig.Hips.position.z
  }

  const tracks = [new THREE.VectorKeyframeTrack('Hips.position', times, hips)]
  for (const b of ANIM.BONES) tracks.push(new THREE.QuaternionKeyframeTrack(b + '.quaternion', times, rot[b]))
  const clip = new THREE.AnimationClip(name, dur, tracks)
  clip.userData = { loop, oneShot: !loop }
  return clip
}

// ---------------------------------------------------------------------------
// Pose authoring
// ---------------------------------------------------------------------------
// Poses are authored as full field dictionaries (bone name -> [x,y,z] degrees,
// `hips` -> [x,y,z] cm offset, `*Palm` -> palm-target vector) at a handful of
// named milestones, then blended between milestones with lerpPose below. Only
// the right arm is authored by hand; the left is ANIM.mirrorPose(...) of it,
// same trick argue.js's rightPoint/mirrorPose pairing uses — a two-handed
// push is symmetric, so there is no reason to write it twice.

/** Lerp two full pose dictionaries key-by-key, array-by-array. Every value in
 *  this file (bone rotations, hips offset, palm targets) is a plain [x,y,z]
 *  array, so one generic function covers all of it — unlike handshake.js's
 *  narrow 11-field scheme (built for one arm), this file's poses touch torso,
 *  head and both arms at once, and writing a bespoke blend per field would
 *  just be this function with the loop unrolled. */
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

/** Full pose fragment (both arms + torso + hips) at a milestone. `arm` is the
 *  rightArm(...) fragment; the left is its mirror. */
function milestone({ hips = [0, 0, 0], Hips = [0, 0, 0], lean = 0, twist = 0, nod = 0, tilt = 0, arm, legs = {} }) {
  return {
    hips, Hips,
    Spine02: [lean * 0.45, twist * 0.34, 0],
    Spine01: [lean * 0.30, twist * 0.33, 0],
    Spine: [lean * 0.25, twist * 0.33, 0],
    neck: [nod * 0.4, -twist * 0.30, 0],
    Head: [nod, -twist * 0.60, tilt],
    ...arm,
    ...ANIM.mirrorPose(arm),
    // Both knees bend the same way — catching balance, not stepping — so no
    // mirroring is needed here the way the arms need ANIM.mirrorPose.
    LeftUpLeg: legs.up || [0, 0, 0], RightUpLeg: legs.up || [0, 0, 0],
    LeftLeg: legs.knee || [0, 0, 0], RightLeg: legs.knee || [0, 0, 0],
    LeftFoot: [0, 0, 0], RightFoot: [0, 0, 0], LeftToeBase: [0, 0, 0], RightToeBase: [0, 0, 0],
  }
}

// REST matches ARMS_DOWN/STAND exactly (see anim.js), so the clip blends in
// clean from idle with no pop.
const SH_REST = [0, 2, -4, 8, 99, 16, 5, 4]
const restPalm = [1, -0.05, -0.32]

// ---------------------------------------------------------------------------
// shove — the winner
// ---------------------------------------------------------------------------
// rest -> WINDUP (lean back, elbows cocked toward the ribs) -> THRUST (both
// hands drive forward and out, hard) -> a short HOLD at full extension so the
// contact frame reads -> SETTLE, a dismissive two-hand brush-off with a
// confident backward lean, not a return to neutral rest.
const SH_WINDUP_T = 0.20
const SH_HOLD_T = 0.34
export const SHOVE_CONTACT_T = 0.28   // inside the hold window, see below
const SH_DUR = 1.65

const WINDUP = milestone({
  lean: -9, nod: -3,
  arm: rightArm(-8, 16, -18, 4, 68, 78, -6, 2, [0.55, -0.05, 0.25]),
})
// Arm numbers here are a fitted solve, not a guess: found by grid search over
// [shY, shZ, armX, armY, armZ, elbow] for the combination that lands the
// right palm on the character's own midline (x=0) at chest height, the same
// "own midline" contract highfive.js's HF_CONTACT documents. See
// measureContact() below — CONTACT_Y_CM/CONTACT_Z_CM are read off this pose,
// not chosen independently of it.
const THRUST = milestone({
  lean: 15, nod: 4, twist: 2,
  hips: [0, 0, 3],
  arm: rightArm(10, 5, -8, 92, 15, 25, -4, 6, [-0.08, 0.05, 0.97]),
})
// Brush-off: both hands sweep in and wipe past each other once at chest
// height (a small, deliberate ArmY swing on top of the settle blend, see
// shovePose's `brush` term below), while the stance opens back up and the
// torso leans back into something cockier than plain rest.
const SETTLE = milestone({
  lean: -5, nod: -6, twist: 5,
  arm: rightArm(-4, 8, -14, 12, 78, 32, 6, 3, [0.5, -0.25, -0.05]),
})

const SH_SEGS = [
  // rest -> windup: an unhurried pull-back, the tell before the push.
  [SH_WINDUP_T, milestone({ arm: rightArm(...SH_REST, restPalm) }), WINDUP, smooth],
  // windup -> thrust: explosive. Slow to start, most of the travel lands in
  // the last few frames — pow(u, 2.4) is the "coiled spring" curve.
  [SHOVE_CONTACT_T, WINDUP, THRUST, u => Math.pow(u, 2.4)],
  // brief hold at full extension — this is the contact beat itself.
  [SH_HOLD_T, THRUST, THRUST, u => u],
  [1.00, THRUST, SETTLE, smooth],
]

function shBlend(t) {
  let i = 0, t0 = 0
  while (i < SH_SEGS.length - 1 && t >= SH_SEGS[i][0]) { t0 = SH_SEGS[i][0]; i++ }
  const [t1, from, to, easing] = SH_SEGS[i]
  const u = easing(clamp01(t1 === t0 ? 1 : (t - t0) / (t1 - t0)))
  return lerpPose(from, to, u)
}

/** Small ArmY sweep layered onto the final segment only — the "wipe your
 *  hands off" beat. Zero at both ends of its window so it never fights the
 *  segment blend around it. */
function brushEnvelope(t) {
  if (t < SH_HOLD_T || t > 1) return 0
  const u = (t - SH_HOLD_T) / (1 - SH_HOLD_T)
  return Math.sin(TAU * 1.5 * u) * (u < 0.85 ? 1 : (1 - u) / 0.15)
}

function shovePose(t) {
  const v = shBlend(t)
  const brush = brushEnvelope(t)
  return {
    ...ANIM.STANDING,
    ...v,
    RightArm: [v.RightArm[0], v.RightArm[1] + 10 * brush, v.RightArm[2]],
    LeftArm: [v.LeftArm[0], v.LeftArm[1] - 10 * brush, v.LeftArm[2]],
  }
}

// ---------------------------------------------------------------------------
// shoveReact — the loser
// ---------------------------------------------------------------------------
// rest, held, until the same contact frame the pusher lands on -> JOLT (a
// fast snap, torso rocked back, arms flinch up) -> STAGGER (the hips
// translation that sells the step back, knees bend to catch balance) ->
// DROOP (settles, does not recover to rest — shoulders down, head down).
const RE_JOLT_T = SHOVE_CONTACT_T + 0.10
const RE_STAGGER_T = 0.70
const STEP_BACK_CM = 34   // see the header note on why hips translate here

const REST_POSE = milestone({ arm: rightArm(...SH_REST, restPalm) })
const JOLT = milestone({
  lean: -20, nod: -13, twist: -3,
  arm: rightArm(4, 40, -70, 26, 20, 62, -18, 10, [0.2, 0.5, 0.55]),
})
const STAGGER = milestone({
  lean: -9, nod: -6,
  hips: [0, -1, -STEP_BACK_CM],
  legs: { up: [-8, 2, 2], knee: [14, 0, 0] },
  arm: rightArm(2, 26, -40, 18, 45, 40, -6, 6, [0.4, 0.2, 0.3]),
})
const DROOP = milestone({
  lean: 8, nod: 15, twist: 0,
  hips: [0, -1, -STEP_BACK_CM],
  legs: { up: [-4, 1, 1], knee: [8, 0, 0] },
  arm: rightArm(-10, 30, -6, 6, 96, 20, 6, 4, [0.7, -0.4, -0.15]),
})

const RE_SEGS = [
  [SHOVE_CONTACT_T, REST_POSE, REST_POSE, u => u],
  [RE_JOLT_T, REST_POSE, JOLT, u => Math.pow(u, 0.4)],   // a snap, not a wind-up
  [RE_STAGGER_T, JOLT, STAGGER, smooth],
  [1.00, STAGGER, DROOP, smooth],
]

function reactBlend(t) {
  let i = 0, t0 = 0
  while (i < RE_SEGS.length - 1 && t >= RE_SEGS[i][0]) { t0 = RE_SEGS[i][0]; i++ }
  const [t1, from, to, easing] = RE_SEGS[i]
  const u = easing(clamp01(t1 === t0 ? 1 : (t - t0) / (t1 - t0)))
  return lerpPose(from, to, u)
}

function shoveReactPose(t) {
  const v = reactBlend(t)
  return { ...ANIM.STANDING, ...v }
}

// ---------------------------------------------------------------------------
// Specs / registry
// ---------------------------------------------------------------------------
// 60 keys over 1.65s samples every ~28ms — enough to not facet the explosive
// windup->thrust segment (the fastest thing in either clip, ~0.08s wide) and
// to land a sample close to SHOVE_CONTACT_T for measurement/scanning.
const SHOVE_KEYS = 60
export const SHOVE_SPEC = { fn: shovePose, dur: SH_DUR, keys: SHOVE_KEYS, loop: false }
export const SHOVE_REACT_SPEC = { fn: shoveReactPose, dur: SH_DUR, keys: SHOVE_KEYS, loop: false }

/** Registry in the {fn, dur, keys, loop} shape anim.js's own CLIPS table
 *  uses — `Object.assign(ANIM.CLIPS, registry)` folds it straight in. */
export const registry = { shove: SHOVE_SPEC, shoveReact: SHOVE_REACT_SPEC }

const _clips = {}
export function getClip(name) {
  if (!registry[name]) throw new Error(`shove: no clip "${name}". Have: ${Object.keys(registry).join(', ')}`)
  if (!_clips[name]) _clips[name] = buildClipFromSpec(name, registry[name])
  return _clips[name]
}

// ---------------------------------------------------------------------------
// Spacing — measured off the pusher's own contact frame, same discipline as
// handshake.js's CONTACT_Y_CM/CONTACT_Z_CM (fitted, not eyeballed).
// ---------------------------------------------------------------------------
export const CONTACT_Y_CM = 115.1
export const CONTACT_Z_CM = 59.7

export const SHOVE_SPACING_RATIO = (2 * CONTACT_Z_CM) / MODEL_HEIGHT_CM
export const SHOVE_SPACING = SHOVE_SPACING_RATIO * CHARACTER_HEIGHT

export function spacingFor(height = CHARACTER_HEIGHT) {
  return SHOVE_SPACING_RATIO * height
}

/** Where the right palm sits at SHOVE_CONTACT_T, character space (armature
 *  cm) — used to fit CONTACT_Y_CM/CONTACT_Z_CM above. Exported so a test
 *  page can re-run the measurement after a pose edit, same as handshake.js's
 *  measureContact. */
export function measureContact() {
  const rig = makeRig()
  ANIM.applyPose(rig.Hips, shovePose(SHOVE_CONTACT_T))
  return palmPoint(rig.Hips, 'Right', MODEL_HEIGHT_CM)
}

// ---------------------------------------------------------------------------
// Marks — same shape as highfive.js's highfiveMarks / argue.js's argueMarks.
// ---------------------------------------------------------------------------
/**
 * @param {number|THREE.Vector3|number[]} aPos winner's current position
 * @param {number|THREE.Vector3|number[]} bPos loser's current position
 */
export function shoveMarks(aPos, bPos, spacing = SHOVE_SPACING) {
  return highfiveMarks(aPos, bPos, spacing)
}

export { palmPoint, handPoint }

// ---------------------------------------------------------------------------
// Measurement helpers for the harness
// ---------------------------------------------------------------------------
/** World position of a bone on the scratch rig at a given clip/t, character
 *  space (armature cm) — mirrors argue.js's boneAt. */
export function boneAt(clipName, t, boneName) {
  const rig = makeRig()
  ANIM.applyPose(rig.Hips, registry[clipName].fn(t))
  const b = rig[boneName]
  b.updateWorldMatrix(true, false)
  return new THREE.Vector3().setFromMatrixPosition(b.matrixWorld)
}
