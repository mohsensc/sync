// Slap: an alternate rung-3 "abort" beat, alongside shove.js and waveoff.js.
// One agent out-authoritied the other and this is the mean, funny version of
// it — a cartoon slap. The whole thing is sold on timing: a long, obvious
// wind-up (anticipation), a contact swing so fast it barely samples, a short
// hold so the hit reads, then follow-through into a satisfied settle. The
// loser's head whips with it and they stagger off balance — no blood, no
// grimace, just a big silly haymaker and a bigger silly reaction.
//
// Same discipline as clips/shove.js:
//
//   1. One canonical spacing, authored from the clip's own contact geometry.
//      See measureContact()/CONTACT_Y_CM/CONTACT_Z_CM below — this time the
//      target is head height, not chest, since a slap lands on the cheek.
//   2. Marks are the primitive — the controller settles the pair onto the
//      line between them before anything plays.
//   3. Asymmetric pair, `a` always wins: this file exports `slap` (the
//      slapper) and `slapReact` (the one who eats it), same duration,
//      started the same frame.
//
// This file duplicates shove.js's scratch-rig/clip-builder boilerplate
// rather than importing it — see shove.js's own header for why (anim.js
// doesn't export the internals that turn a pose function into a clip, and
// every paired-action file in this codebase builds its own rather than
// share that plumbing across unrelated clips).
//
// HIPS TRANSLATION, ON PURPOSE: same rule-break as shove.js. The loser's
// stagger is a dragged-hips slide, not a stepped recovery — there's no
// walk-cycle to blend one out of, and at this length (well under a second)
// a slide reads as a stumble. Keep the slide short if it ever starts to
// read as skating; see shove.js's note on the same trade-off.
//
// No IK anywhere. See the office README's note at the bottom.

import * as THREE from 'three'
import * as ANIM from '../anim.js'
import { highfiveMarks, palmPoint, handPoint, CHARACTER_HEIGHT, MODEL_HEIGHT_CM } from '../highfive.js'

const TAU = Math.PI * 2
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
// Pose authoring — same milestone/lerp scheme as shove.js.
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

function milestone({ hips = [0, 0, 0], Hips = [0, 0, 0], lean = 0, twist = 0, nod = 0, tilt = 0, arm, legs = {}, mirrorArm = true }) {
  return {
    hips, Hips,
    Spine02: [lean * 0.45, twist * 0.34, 0],
    Spine01: [lean * 0.30, twist * 0.33, 0],
    Spine: [lean * 0.25, twist * 0.33, 0],
    neck: [nod * 0.4, -twist * 0.30, 0],
    Head: [nod, -twist * 0.60, tilt],
    ...arm,
    ...(mirrorArm ? ANIM.mirrorPose(arm) : {}),
    LeftUpLeg: legs.up || [0, 0, 0], RightUpLeg: legs.up || [0, 0, 0],
    LeftLeg: legs.knee || [0, 0, 0], RightLeg: legs.knee || [0, 0, 0],
    LeftFoot: [0, 0, 0], RightFoot: [0, 0, 0], LeftToeBase: [0, 0, 0], RightToeBase: [0, 0, 0],
  }
}

const SH_REST = [0, 2, -4, 8, 99, 16, 5, 4]
const restPalm = [1, -0.05, -0.32]

// ---------------------------------------------------------------------------
// slap — the winner
// ---------------------------------------------------------------------------
// rest -> WINDUP (arm cocks way out to the side at shoulder height, torso
// winds up with it) -> a HOLD at the top of the windup, the anticipation
// beat that sells "this is coming" -> SWING, a fast horizontal arc across
// the body to CONTACT -> a short hold at full extension so the hit reads ->
// FOLLOWTHROUGH, the arm keeps carrying past contact before easing back ->
// SETTLE, a cocky, weight-shifted stance, arm resting, not a return to rest.
const SL_WINDUP_T = 0.30
const SL_WINDUP_HOLD_T = 0.42     // the anticipation hold — nothing moves here
export const SLAP_CONTACT_T = 0.50   // fast: 0.08 of SL_DUR from top of windup
const SL_HOLD_T = 0.58
const SL_FOLLOW_T = 0.72
const SL_DUR = 1.35

const WINDUP = milestone({
  lean: -6, nod: -2, twist: -22,
  arm: rightArm(2, 60, -85, 10, 12, 60, -10, 8, [0.15, 0.35, 0.4]),
})
// Contact numbers are a fitted solve, browser-verified against the running
// harness (slap-test.html), not a guess: gridded over lean/twist/hips-Z and
// the arm's own shoulder/elbow/hand angles for the combination that lands
// the right palm nearest the LOSER'S OWN HEAD BONE (not the winner's own
// midline the way shove.js's chest-height THRUST does — a slap needs the
// actual target, since a fixed midline point is nowhere near head height
// once you're checking against a real skull position). A chunk of the
// closing distance is a forward hips lunge (hips-Z) rather than pure arm
// reach — a cartoon slap commits the whole body, not just the hand.
// Landed at ~10cm palm-to-head at SLAP_SPACING — see slap-test.html's
// palm→cheek column. That residual is expected: there is nothing on this
// rig to represent cheek depth (same BODY_DEPTH_CM situation shove.js
// documents for the chest), and 10cm reads as a real hit once the loser's
// own head is whipping toward the hand on contact.
const CONTACT = milestone({
  lean: 6, nod: 2, twist: 8,
  hips: [0, 0, 20],
  arm: rightArm(15, 5, -8, 80, 15, 20, -4, 6, [-0.08, 0.05, 0.97]),
})
const FOLLOW = milestone({
  lean: 8, nod: 4, twist: 16,
  hips: [0, 0, 20],
  arm: rightArm(20, -2, -4, 88, -6, 16, -6, 2, [-0.2, -0.05, 0.9]),
})
const SETTLE = milestone({
  lean: -6, nod: -8, twist: 12,
  arm: rightArm(-6, 10, -16, 14, 76, 30, 6, 3, [0.5, -0.2, -0.05]),
})

const SL_SEGS = [
  // rest -> windup: unhurried, telegraphed on purpose — the whole joke is
  // that the loser (and the viewer) sees this coming.
  [SL_WINDUP_T, milestone({ arm: rightArm(...SH_REST, restPalm) }), WINDUP, smooth],
  // the anticipation hold: WINDUP to WINDUP, nothing changes but time passes.
  [SL_WINDUP_HOLD_T, WINDUP, WINDUP, u => u],
  // windup -> contact: the whole swing lands in 0.08 of the clip's length.
  // pow(u, 3) so almost nothing happens until the last few samples.
  [SLAP_CONTACT_T, WINDUP, CONTACT, u => Math.pow(u, 3)],
  // hold at full extension — the contact beat itself.
  [SL_HOLD_T, CONTACT, CONTACT, u => u],
  // follow-through: the arm keeps carrying past the hit before easing back.
  [SL_FOLLOW_T, CONTACT, FOLLOW, smooth],
  [1.00, FOLLOW, SETTLE, smooth],
]

function slBlend(t) {
  let i = 0, t0 = 0
  while (i < SL_SEGS.length - 1 && t >= SL_SEGS[i][0]) { t0 = SL_SEGS[i][0]; i++ }
  const [t1, from, to, easing] = SL_SEGS[i]
  const u = easing(clamp01(t1 === t0 ? 1 : (t - t0) / (t1 - t0)))
  return lerpPose(from, to, u)
}

function slapPose(t) {
  return { ...ANIM.STANDING, ...slBlend(t) }
}

// ---------------------------------------------------------------------------
// slapReact — the loser
// ---------------------------------------------------------------------------
// rest, held, until the same contact frame the slapper lands on -> WHIP (a
// fast head/neck snap to the side, torso rocked with it — the classic
// cartoon head-turn) -> STAGGER (a half-step sideways, knees buckling) ->
// DAZED (settles, head still canted, one hand slowly drifting up to the
// struck cheek — the small human beat that sells it).
const RE_WHIP_T = SLAP_CONTACT_T + 0.07
const RE_STAGGER_T = 0.66
const STEP_CM = 22   // smaller than shove's STEP_BACK_CM — a stagger, not a shove

const REST_POSE = milestone({ arm: rightArm(...SH_REST, restPalm) })
const WHIP = milestone({
  lean: -4, nod: 6, twist: -34, tilt: -18,
  arm: rightArm(4, 30, -50, 20, 15, 45, -12, 8, [0.3, 0.3, 0.4]),
})
const STAGGER = milestone({
  lean: 6, nod: 10, twist: -22, tilt: -12,
  hips: [10, -1, -STEP_CM],
  legs: { up: [-6, 3, -3], knee: [16, 0, 0] },
  arm: rightArm(0, 20, -30, 14, 40, 34, -6, 5, [0.4, 0.2, 0.3]),
})
// The struck-cheek touch is layered on top of DAZED via cheekEnvelope below,
// on the LEFT arm (mirrors the slapper's right hand landing on this side's
// own right cheek in a face-to-face pair) rather than baked into this
// milestone, so it can ease in slowly without fighting the STAGGER blend.
const DAZED = milestone({
  lean: 10, nod: 14, twist: -10, tilt: -8,
  hips: [10, -1, -STEP_CM],
  legs: { up: [-3, 1, -1], knee: [8, 0, 0] },
  arm: rightArm(-8, 26, -8, 8, 92, 22, 6, 4, [0.65, -0.35, -0.1]),
})

const RE_SEGS = [
  [SLAP_CONTACT_T, REST_POSE, REST_POSE, u => u],
  [RE_WHIP_T, REST_POSE, WHIP, u => Math.pow(u, 0.35)],   // snap, not a wind-up
  [RE_STAGGER_T, WHIP, STAGGER, smooth],
  [1.00, STAGGER, DAZED, smooth],
]

function reactBlend(t) {
  let i = 0, t0 = 0
  while (i < RE_SEGS.length - 1 && t >= RE_SEGS[i][0]) { t0 = RE_SEGS[i][0]; i++ }
  const [t1, from, to, easing] = RE_SEGS[i]
  const u = easing(clamp01(t1 === t0 ? 1 : (t - t0) / (t1 - t0)))
  return lerpPose(from, to, u)
}

/** Hand-to-cheek drift, DAZED's back half only — zero at the DAZED boundary
 *  so it never fights the STAGGER->DAZED blend above it. */
function cheekEnvelope(t) {
  if (t < RE_STAGGER_T) return 0
  const u = (t - RE_STAGGER_T) / (1 - RE_STAGGER_T)
  return smooth(clamp01((u - 0.4) / 0.6))
}

function slapReactPose(t) {
  const v = reactBlend(t)
  const c = cheekEnvelope(t)
  if (c <= 0) return { ...ANIM.STANDING, ...v }
  // Left arm rises from its DAZED resting angle toward the cheek — a small
  // extra ArmY/ForeArm flex layered on top, not a separate milestone, so it
  // never has to be kept in sync with DAZED's own numbers by hand.
  return {
    ...ANIM.STANDING, ...v,
    LeftArm: [v.LeftArm[0], v.LeftArm[1] - 55 * c, v.LeftArm[2] + 20 * c],
    LeftForeArm: [v.LeftForeArm[0], v.LeftForeArm[1] - 70 * c, v.LeftForeArm[2]],
  }
}

// ---------------------------------------------------------------------------
// Specs / registry
// ---------------------------------------------------------------------------
// 81 keys, not a round number: chosen so (keys-1) * SLAP_CONTACT_T is an
// integer (80 * 0.5 = 40), which lands an actual sample exactly ON the
// contact frame instead of straddling it. This matters more here than in
// shove.js: the windup->contact swing is a pow(u,3) curve, almost all of it
// packed into the last few percent, so a sample landing even one step off
// SLAP_CONTACT_T badly undershoots the full extension — measured in the
// browser harness (holdContact() froze the pose ~15cm short of the fitted
// CONTACT pose at 60 keys, purely from keyframe straddling, not a bad fit).
// At 81 keys the ~0.108s windup-hold->contact window still gets ~6.4
// samples, comfortably over doubletake.js's own "~4 or it mushes" rule.
const SLAP_KEYS = 81
export const SLAP_SPEC = { fn: slapPose, dur: SL_DUR, keys: SLAP_KEYS, loop: false }
export const SLAP_REACT_SPEC = { fn: slapReactPose, dur: SL_DUR, keys: SLAP_KEYS, loop: false }

export const registry = { slap: SLAP_SPEC, slapReact: SLAP_REACT_SPEC }

const _clips = {}
export function getClip(name) {
  if (!registry[name]) throw new Error(`slap: no clip "${name}". Have: ${Object.keys(registry).join(', ')}`)
  if (!_clips[name]) _clips[name] = buildClipFromSpec(name, registry[name])
  return _clips[name]
}

// ---------------------------------------------------------------------------
// Spacing — measured off the slapper's own contact frame, same discipline as
// shove.js's CONTACT_Y_CM/CONTACT_Z_CM, but at HEAD height, not chest.
//
// Not doubled, same reasoning as shove.js: this is one-sided, the slapper's
// reach does all the travelling. See shove.js's own note on why doubling a
// one-sided reach overshoots.
// ---------------------------------------------------------------------------
export const CONTACT_Y_CM = 119.1
export const CONTACT_Z_CM = 68.8

// Same BODY_DEPTH_CM stand-in as shove.js — there is nothing on this rig to
// measure a face's depth off, so this is chosen to keep the two heads from
// overlapping at CONTACT's forward lean while the palm still reads as
// landing ON the cheek rather than stopping short of it.
const BODY_DEPTH_CM = 20

export const SLAP_SPACING_RATIO = (CONTACT_Z_CM + BODY_DEPTH_CM) / MODEL_HEIGHT_CM
export const SLAP_SPACING = SLAP_SPACING_RATIO * CHARACTER_HEIGHT

export function spacingFor(height = CHARACTER_HEIGHT) {
  return SLAP_SPACING_RATIO * height
}

/** Where the right palm sits at SLAP_CONTACT_T, character space (armature
 *  cm) — used to fit CONTACT_Y_CM/CONTACT_Z_CM above. */
export function measureContact() {
  const rig = makeRig()
  ANIM.applyPose(rig.Hips, slapPose(SLAP_CONTACT_T))
  return palmPoint(rig.Hips, 'Right', MODEL_HEIGHT_CM)
}

// ---------------------------------------------------------------------------
// Marks — same shape as shove.js's shoveMarks.
// ---------------------------------------------------------------------------
/**
 * @param {number|THREE.Vector3|number[]} aPos winner's current position
 * @param {number|THREE.Vector3|number[]} bPos loser's current position
 */
export function slapMarks(aPos, bPos, spacing = SLAP_SPACING) {
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
