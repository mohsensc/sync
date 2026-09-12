// Chest bump: the rung-2 "collaboration" beat, alternate take to highfive.js.
// Both agents load, hop toward each other, meet chest-to-chest at the peak,
// bounce back off the impact, and land staggered before settling. Where a
// high five is a light touch, this is a shove they both signed up for —
// weight is the whole point: a real anticipation dip, an airborne reach, a
// visible recoil off contact, and a landing that has to absorb it.
//
// Same discipline as clips/shove.js, which this file's plumbing is cloned
// from (scratch rig for measurement, milestone/lerpPose pose authoring):
//
//   1. One canonical spacing, fitted from the clip's own contact frame, not
//      eyeballed. See measureContact() / chestPoint() below.
//   2. Marks are the primitive — walk the pair onto the line between them,
//      centred, facing each other, before anything plays.
//   3. Symmetric pair, like highfive/handshake: both sides play the SAME
//      clip. Facing each other is already the mirror.
//
// THE ONE DELIBERATE RULE BREAK THIS FILE SHARES WITH shove.js: HIPS
// TRANSLATION. Every clip that keeps both feet on the ground holds
// `hips: [0,0,0]`, because the feet are children of the hips and dragging the
// pelvis around drags them across the floor. A hop is the one motion on this
// rig where that stops being a problem: both feet leave the ground together,
// so translating the hips forward mid-air reads as a jump, not a skate. See
// CROUCH/LAUNCH/CONTACT below — the forward reach comes from real hip travel,
// not from leaning alone, which is what a jump toward another person actually
// looks like from the outside.
//
// No IK anywhere. See the note at the bottom of the office README.

import * as THREE from 'three'
import * as ANIM from '../anim.js'
import { yawTowards, palmPoint, handPoint, CHARACTER_HEIGHT, MODEL_HEIGHT_CM } from '../highfive.js'
import { highfiveMarks } from '../highfive.js'

const TAU = Math.PI * 2
const clamp01 = u => Math.max(0, Math.min(1, u))
const smooth = u => u * u * (3 - 2 * u)

// ---------------------------------------------------------------------------
// Scratch rig — identical scaffold to handshake.js/shove.js's own copies.
// anim.js doesn't export the bone hierarchy, so each paired-action file
// builds its own from anim.js's flat BIND table plus the topology documented
// in anim.js's header.
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
// Pose authoring — full-dictionary milestones blended segment-wise, same
// pattern as clips/shove.js's milestone()/lerpPose(). Only the right arm is
// authored by hand; the left comes from ANIM.mirrorPose, same trick — a
// two-armed symmetric gesture is exactly what that mirror was built for.
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
    // Both knees bend the same way — loading and landing, not stepping — so
    // no mirroring needed, same as shove.js's STAGGER/DROOP legs.
    LeftUpLeg: legs.up || [0, 0, 0], RightUpLeg: legs.up || [0, 0, 0],
    LeftLeg: legs.knee || [0, 0, 0], RightLeg: legs.knee || [0, 0, 0],
    LeftFoot: [0, 0, 0], RightFoot: [0, 0, 0], LeftToeBase: [0, 0, 0], RightToeBase: [0, 0, 0],
  }
}

const REST_ARM = [0, 2, -4, 8, 99, 16, 5, 4]   // == ARMS_DOWN's right arm exactly
const restPalm = [1, -0.05, -0.32]

// rest -> CROUCH (load: sink, pull elbows in) -> LAUNCH (rising, arms
// starting to open) -> CONTACT (hop's apex — hips carry the forward reach,
// arms flung wide, torso leaning in) -> RECOIL (the bounce-back: torso
// snaps away, arms pop further out/up) -> LAND (deep knee bend absorbing
// the landing, hips pulled back a touch — the stagger) -> SETTLE (== rest).
const HOP_FORWARD_CM = 26   // hip travel at the apex — see CONTACT below

const REST = milestone({ arm: rightArm(...REST_ARM, restPalm) })
const CROUCH = milestone({
  hips: [0, -7, -4], lean: -7, nod: -3,
  legs: { up: [-9, 0, 0], knee: [16, 0, 0] },
  arm: rightArm(-10, 30, -30, 10, 55, 55, 8, 4, [0.5, 0.1, 0.35]),
})
const LAUNCH = milestone({
  hips: [0, 13, 11], lean: 4, nod: 2,
  legs: { up: [-3, 0, 0], knee: [6, 0, 0] },
  arm: rightArm(2, 10, -10, 45, 25, 30, -2, 3, [0.15, 0.3, 0.85]),
})
// Fitted, not eyeballed: HOP_FORWARD_CM is the actual hip travel at this
// frame, and the arm numbers below are chosen to open the shoulders wide
// (armZ near 0 = close to the T-pose's horizontal, not hanging) so the
// gesture reads as "arms out" rather than "still reaching forward" at the
// moment of contact. See chestPoint()/measureContact() for how the resulting
// spacing gets derived from this pose rather than picked independently.
const CONTACT = milestone({
  hips: [0, 18, HOP_FORWARD_CM], lean: 18, nod: 3,
  legs: { up: [-2, 0, 0], knee: [4, 0, 0] },
  arm: rightArm(14, -6, 6, 70, -8, 10, -6, 6, [-0.1, 0.55, 0.75]),
})
const RECOIL = milestone({
  hips: [0, 9, HOP_FORWARD_CM * 0.55], lean: -16, nod: -8,
  legs: { up: [-6, 0, 0], knee: [12, 0, 0] },
  arm: rightArm(18, -14, 20, 85, -18, 14, -10, 8, [-0.3, 0.6, 0.55]),
})
const LAND = milestone({
  hips: [0, -9, -7], lean: 7, nod: 6,
  legs: { up: [-15, 2, 2], knee: [28, 0, 0] },
  arm: rightArm(-6, 20, -12, 20, 75, 30, 4, 5, [0.55, 0.1, 0.2]),
})
const SETTLE = REST

const CB_DUR = 1.55
export const CHESTBUMP_CROUCH_T = 0.13
export const CHESTBUMP_LAUNCH_T = 0.28
/** Fraction of the clip at which the chests meet — the apex of the hop. */
export const CHESTBUMP_CONTACT_T = 0.40
export const CHESTBUMP_RECOIL_T = 0.55
export const CHESTBUMP_LAND_T = 0.80

const CB_SEGS = [
  [CHESTBUMP_CROUCH_T, REST, CROUCH, smooth],
  // crouch -> launch: quick, explosive push off the ground.
  [CHESTBUMP_LAUNCH_T, CROUCH, LAUNCH, u => Math.pow(u, 0.65)],
  // launch -> contact: accelerating into the meet, same "coiled spring"
  // shape shove.js's windup->thrust segment uses.
  [CHESTBUMP_CONTACT_T, LAUNCH, CONTACT, u => Math.pow(u, 1.6)],
  // the bounce-back: fast off contact, slower as it settles into the arch.
  [CHESTBUMP_RECOIL_T, CONTACT, RECOIL, u => Math.pow(u, 0.55)],
  [CHESTBUMP_LAND_T, RECOIL, LAND, smooth],
  [1.00, LAND, SETTLE, smooth],
]

function cbBlend(t) {
  let i = 0, t0 = 0
  while (i < CB_SEGS.length - 1 && t >= CB_SEGS[i][0]) { t0 = CB_SEGS[i][0]; i++ }
  const [t1, from, to, easing] = CB_SEGS[i]
  const u = easing(clamp01(t1 === t0 ? 1 : (t - t0) / (t1 - t0)))
  return lerpPose(from, to, u)
}

function chestbumpPose(t) {
  return { ...ANIM.STANDING, ...cbBlend(t) }
}

// ---------------------------------------------------------------------------
// Specs / registry
// ---------------------------------------------------------------------------
// 70 keys over 1.55s samples every ~22ms — the fastest segment (launch ->
// contact, ~0.12s wide) still gets ~5 samples, enough that the hop's rise
// doesn't facet the way a coarser sampling would.
const CB_KEYS = 70
export const CHESTBUMP_SPEC = { fn: chestbumpPose, dur: CB_DUR, keys: CB_KEYS, loop: false }

/** Registry in the {fn, dur, keys, loop} shape anim.js's own CLIPS table
 *  uses — `Object.assign(ANIM.CLIPS, registry)` folds it straight in. */
export const registry = { chestbump: CHESTBUMP_SPEC }

// Folded into anim.js's own CLIPS table at import time, so these play by name
// through ANIM.crossfade like every other clip — one clip table, one owner of
// the mixer's weights. See anim.js's CLIPS header for the timing rule (the
// merge has to happen before the first createClips(), which import time is).
Object.assign(ANIM.CLIPS, registry)


// ---------------------------------------------------------------------------
// Spacing — mutual, like highfive/handshake (both sides travel to a shared
// point), unlike shove's one-sided reach. Each side's own contribution is
// HOP_FORWARD_CM of real hip travel plus BODY_DEPTH_CM, a chosen stand-in
// (reused from shove.js's own constant — same rig, same "no torso depth to
// speak of" problem) for how far a chest sits in front of the spine
// centreline. See chestPoint()/measureContact() below: this is checked
// against the actual pose, not just asserted.
// ---------------------------------------------------------------------------
const BODY_DEPTH_CM = 20

/** Where a character's own "chest surface" sits at a given t, character
 *  space (armature cm): the Spine02 bone's position, nudged forward by
 *  BODY_DEPTH_CM along the bone's own (posed) forward axis. Spine02 rather
 *  than Spine — it's the belly/lower-chest bone in this rig's inverted
 *  chain (see anim.js's header) and sits closest to where two people
 *  actually make contact in a chest bump. */
const _p = new THREE.Vector3(), _q = new THREE.Quaternion(), _s = new THREE.Vector3()
const _fwd = new THREE.Vector3()
export function chestPoint(root, height = CHARACTER_HEIGHT) {
  const spine = root.getObjectByName('Spine02')
  if (!spine) return null
  spine.updateWorldMatrix(true, false)
  spine.matrixWorld.decompose(_p, _q, _s)
  const k = height / MODEL_HEIGHT_CM
  _fwd.set(0, 0, 1).applyQuaternion(_q)
  return _p.clone().addScaledVector(_fwd, BODY_DEPTH_CM * k)
}

/** Where the chest point sits at CHESTBUMP_CONTACT_T, in the scratch rig
 *  (character space, armature cm) — used to fit CONTACT_Z_CM below, same
 *  discipline as handshake.js's / shove.js's own measureContact(). Exported
 *  so chestbump-test.html can re-run the measurement after a pose edit. */
export function measureContact() {
  const rig = makeRig()
  ANIM.applyPose(rig.Hips, chestbumpPose(CHESTBUMP_CONTACT_T))
  return chestPoint(rig.Hips, MODEL_HEIGHT_CM)
}

/** Own-midline forward reach at contact, armature cm — measured off the
 *  clip (see measureContact() above), not just the raw HOP_FORWARD_CM +
 *  BODY_DEPTH_CM sum: the forward lean rotates Spine02 as well as
 *  translating the hips, so the actual chest point lands a bit further out
 *  than hip travel alone would suggest. Re-run measureContact() and update
 *  this if CONTACT's pose numbers move. */
export const CONTACT_Z_CM = 47.06

export const CHESTBUMP_SPACING_RATIO = (2 * CONTACT_Z_CM) / MODEL_HEIGHT_CM
export const CHESTBUMP_SPACING = CHESTBUMP_SPACING_RATIO * CHARACTER_HEIGHT

export function spacingFor(height = CHARACTER_HEIGHT) {
  return CHESTBUMP_SPACING_RATIO * height
}

// ---------------------------------------------------------------------------
// Marks — same shape as highfive.js's highfiveMarks (mutual, on the a-b
// line, centred on the midpoint).
// ---------------------------------------------------------------------------
export function chestbumpMarks(aPos, bPos, spacing = CHESTBUMP_SPACING) {
  return highfiveMarks(aPos, bPos, spacing)
}

export { yawTowards, palmPoint, handPoint }
