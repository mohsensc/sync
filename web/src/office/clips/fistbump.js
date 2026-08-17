// Fist bump: the rung-2 "collaboration" beat, understated alternate to
// highfive.js and chestbump.js. No run-up, no big swing — walk up, one
// crisp bump, a beat of hold, part. Where chestbump.js spends its whole
// clip on anticipation and follow-through, this one is almost all arrival:
// the entire personality is in how direct and clean the approach reads, not
// in how big the gesture is.
//
// Same discipline as highfive.js / handshake.js:
//
//   1. One canonical spacing, fitted from the clip's own contact frame
//      (palmPoint, reused from highfive.js — this rig has no separate
//      finger geometry, so "front of the fist" and "front of the palm" are
//      the same measured point, same as shove.js's push reuses it too).
//   2. Marks are the primitive — walk the pair onto the line between them,
//      centred, facing each other, before anything plays.
//   3. Symmetric pair: both sides play the SAME clip. Facing each other is
//      already the mirror — see highfive.js's header for the full argument.
//
// No IK anywhere. See the note at the bottom of the office README.

import * as THREE from 'three'
import * as ANIM from '../anim.js'
import { highfiveMarks, yawTowards, palmPoint, handPoint, CHARACTER_HEIGHT, MODEL_HEIGHT_CM } from '../highfive.js'

const clamp01 = u => Math.max(0, Math.min(1, u))
const smooth = u => u * u * (3 - 2 * u)

// ---------------------------------------------------------------------------
// Scratch rig — identical scaffold to handshake.js/shove.js/chestbump.js's
// own copies. See those files' headers for why each one builds its own
// rather than sharing: anim.js exports applyPose but not the bone hierarchy
// that makes it useful outside a live scene.
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
// Pose authoring — same milestone/lerpPose shape as chestbump.js/shove.js,
// but only ever touching the right arm plus a token head tilt: no hips
// travel, no leg bend, no torso lean. Understated is the entire brief.
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

function milestone({ nod = 0, arm }) {
  return {
    hips: [0, 0, 0], Hips: [0, 0, 0],
    Spine02: [0, 0, 0], Spine01: [0, 0, 0], Spine: [0, 0, 0],
    neck: [nod * 0.4, 0, 0], Head: [nod, 0, 0],
    ...arm,
    ...ANIM.mirrorPose(arm),
    LeftUpLeg: [0, 0, 0], RightUpLeg: [0, 0, 0], LeftLeg: [0, 0, 0], RightLeg: [0, 0, 0],
    LeftFoot: [0, 0, 0], RightFoot: [0, 0, 0], LeftToeBase: [0, 0, 0], RightToeBase: [0, 0, 0],
  }
}

const REST_ARM = [0, 2, -4, 8, 99, 16, 5, 4]   // == ARMS_DOWN's right arm exactly
const restPalm = [1, -0.05, -0.32]

const REST = milestone({ arm: rightArm(...REST_ARM, restPalm) })
// The whole gesture: forearm comes up and across to about sternum height,
// fist-forward (palm target squared on the partner, thumb roughly up — the
// same "fist facing partner" idea handshake.js's grip uses, just higher and
// shorter reach, and with no cocked-short-of-contact trick: this arrives
// directly, no anticipation to speak of, which IS the point).
const REACH = milestone({
  nod: -2,
  arm: rightArm(12, 30, -16, 62, 80, 88, -6, 5, [0.05, 0.20, 0.96]),
})
const SETTLE = REST

const FB_DUR = 0.95
/** Fraction of the clip at which the fists meet. */
export const FISTBUMP_CONTACT_T = 0.30
export const FISTBUMP_HOLD_END_T = 0.52

const FB_SEGS = [
  // rest -> reach: direct and quick — no wind-up, that's the whole brief.
  [FISTBUMP_CONTACT_T, REST, REACH, u => Math.pow(u, 0.8)],
  // the beat of hold: flat, nothing moves.
  [FISTBUMP_HOLD_END_T, REACH, REACH, u => u],
  // part: unhurried retreat back to rest.
  [1.00, REACH, SETTLE, smooth],
]

function fbBlend(t) {
  let i = 0, t0 = 0
  while (i < FB_SEGS.length - 1 && t >= FB_SEGS[i][0]) { t0 = FB_SEGS[i][0]; i++ }
  const [t1, from, to, easing] = FB_SEGS[i]
  const u = easing(clamp01(t1 === t0 ? 1 : (t - t0) / (t1 - t0)))
  return lerpPose(from, to, u)
}

function fistbumpPose(t) {
  return { ...ANIM.STANDING, ...fbBlend(t) }
}

// ---------------------------------------------------------------------------
// Specs / registry
// ---------------------------------------------------------------------------
// 40 keys over 0.95s samples every ~24ms — the reach segment is the fastest
// (~0.28s) and still gets a dozen samples, plenty for a motion this small.
const FB_KEYS = 40
export const FISTBUMP_SPEC = { fn: fistbumpPose, dur: FB_DUR, keys: FB_KEYS, loop: false }

/** Registry in the {fn, dur, keys, loop} shape anim.js's own CLIPS table
 *  uses — `Object.assign(ANIM.CLIPS, registry)` folds it straight in. */
export const registry = { fistbump: FISTBUMP_SPEC }

let _clip = null
export function getClip() {
  if (!_clip) _clip = buildClipFromSpec('fistbump', FISTBUMP_SPEC)
  return _clip
}

// ---------------------------------------------------------------------------
// Spacing — mutual, same derivation as highfive.js/handshake.js: both sides
// reach the same distance to a shared midline point, so spacing is 2x one
// side's own reach.
// ---------------------------------------------------------------------------

/** Where the right palm (== front-of-fist, this rig has no finger geometry
 *  beyond the hand bone) sits at FISTBUMP_CONTACT_T, character space
 *  (armature cm) — measured off the clip, same as handshake.js's
 *  CONTACT_Y_CM/CONTACT_Z_CM. Re-run measureContact() if REACH moves. */
export const CONTACT_Y_CM = 104.27
export const CONTACT_Z_CM = 40.30

export const FISTBUMP_SPACING_RATIO = (2 * CONTACT_Z_CM) / MODEL_HEIGHT_CM
export const FISTBUMP_SPACING = FISTBUMP_SPACING_RATIO * CHARACTER_HEIGHT

export function spacingFor(height = CHARACTER_HEIGHT) {
  return FISTBUMP_SPACING_RATIO * height
}

export function measureContact() {
  const rig = makeRig()
  ANIM.applyPose(rig.Hips, fistbumpPose(FISTBUMP_CONTACT_T))
  return palmPoint(rig.Hips, 'Right', MODEL_HEIGHT_CM)
}

// ---------------------------------------------------------------------------
// Marks — same shape as highfive.js's highfiveMarks.
// ---------------------------------------------------------------------------
export function fistbumpMarks(aPos, bPos, spacing = FISTBUMP_SPACING) {
  return highfiveMarks(aPos, bPos, spacing)
}

export { yawTowards, palmPoint, handPoint }
