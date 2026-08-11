// Handshake: right hands meet, two or three shakes, release. Firm, brief, the
// default office greeting between two people who already know each other.
//
// This file follows highfive.js's pattern exactly and does not reinvent it:
//
//   1. Author ONE clip for ONE canonical spacing. Contact geometry lives in
//      the rig, in armature centimetres, and gets turned into a spacing the
//      same way highfive.js does.
//   2. Marks are the primitive. The controller walks both characters onto
//      the line between them, centred on their midpoint, each facing the
//      other, and only then starts the clip. No IK.
//   3. Both characters play the SAME clip. Facing each other is already the
//      mirror — each raises its right hand, and 180 degrees apart puts those
//      on opposite sides in world space, meeting in the middle.
//
// WHY THIS FILE DOES ITS OWN CLIP BUILDING
// anim.js does not export its pose-authoring internals (deltaQuat, the palm
// roll solver, buildClip) — only applyPose, which runs that whole pipeline
// against a live rig. So instead of duplicating the math, this file builds a
// tiny scratch skeleton straight from anim.js's own BIND data and repeatedly
// calls applyPose on it, once per sample, reading the resulting bone
// quaternions into keyframe tracks. That is exactly what anim.js's internal
// buildClip does — same resolvePose, same palm-roll solve, same localQuat —
// just driven from outside instead of from inside. The exported `registry`
// is in the {fn, dur, keys, loop} shape anim.js's own CLIPS table uses, so
// an integrator can fold it in directly without touching this file.
//
// See the note at the bottom of the office README: no IK anywhere in this
// codebase. Marks and canned clips only.

import * as THREE from 'three'
import * as ANIM from '../anim.js'
import { yawTowards, palmPoint, handPoint, CHARACTER_HEIGHT, MODEL_HEIGHT_CM } from '../highfive.js'

const TAU = Math.PI * 2

// ---------------------------------------------------------------------------
// Scratch rig — a bare bone hierarchy built from anim.js's own BIND data, so
// applyPose (exported) can be run against it to produce real keyframes.
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
  for (const name of ANIM.BONES) {
    const p = PARENT[name]
    if (p) bones[p].add(bones[name])
  }
  bones.Hips.updateMatrixWorld(true)
  return bones
}

/** Build a THREE.AnimationClip from a {fn, dur, keys, loop} spec, the same
 *  shape anim.js's internal CLIPS table uses. `fn(t01) -> pose`. */
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
// handshake pose
// ---------------------------------------------------------------------------
// rest -> reach -> GRIP -> [shake x3, layered on top] -> release -> rest
//
// Same [hipsYaw, lean, twist, shY, shZ, armX, armY, armZ, elbow, flex, dev]
// shape highfive.js's clip uses, on the right arm, plus a palm target per key
// (the forearm roll is solved, never picked). The grip itself is geometrically
// close to a high five — palm square to the partner, contact on the own
// midline — just lower (waist, not eye level), shorter reach (elbow stays
// bent, this is not a lunge), and the payload after contact is different: no
// single recoil-and-fall, but a hold at the grip pose with an oscillation
// layered on top so the clasped hands bob together three times before
// letting go.

// Solved, not eyeballed, same discipline as anim.js's HF_CONTACT: fitted so
// the palm centre lands on (x=0, y=CONTACT_Y_CM, z=CONTACT_Z_CM) — see
// measurePose() and the search recorded in the office README. The story that
// fell out of the fit is a good one: the upper arm barely leaves REST
// (armZ 99 -> 95, almost the same swing-down as hanging at the side) and
// nearly all the reach is the elbow opening up (16 -> 113) with a bit of
// shoulder abduction (shZ 2 -> 24) — which is what an actual handshake looks
// like, forearm doing the work while the upper arm stays close to the ribs.
const HS_REST    = [0, 0,  0,  0,  2,   -4,   8,   99,  16,  5,   4]     // == STAND's right arm exactly
const HS_REACH   = [1, 3,  4,  1, 12,   -4,  34,   97,  64, -9,   8]     // elbow already opening, upper arm still at rest
// Cocked short of contact, same trick highfive.js's HF_SWING uses: without a
// key here the reach-to-grip lerp bulges the hand past the contact plane on
// the way in, which puts the two hands through each other a frame early.
const HS_GRIP    = [2, 5, 8, 1.6, 23.88, -4.40, 61.77, 95.55, 113.05, -18, 12]
const HS_RELEASE = [1, 3,  4,  1, 15,   -4,  40,   96,  80,  -12,  10]   // opens up, retreats a touch

const HS_PALM_REST    = [1, -0.05, -0.32]      // hanging, on the thigh
const HS_PALM_REACH   = [0.55, 0.20, 0.35]     // rolling up and forward, not yet squared
const HS_PALM_GRIP    = [0.02, 0.06, 0.998]    // square on to the partner, thumb roughly up
const HS_PALM_RELEASE = [0.35, 0.20, 0.62]     // turning back in as the arm drops

// How committed the pose is, per key — drives the spine/head/off-arm so they
// don't need their own timing curves.
const HS_K = { rest: 0, reach: 0.55, grip: 1, release: 0.55 }

const lerpArr = (a, b, u) => a.map((v, i) => v + (b[i] - v) * u)
const smooth = u => u * u * (3 - 2 * u)
const clamp01 = u => Math.max(0, Math.min(1, u))

/** Fraction of the clip at which the grip closes (first contact). Must land
 *  on a sampled key — see HANDSHAKE_SPEC.keys below, chosen so 0.20 / 0.32 /
 *  0.72 / 0.84 are all exact multiples of 1/25. Slerped between neighbours
 *  the grip lands a centimetre or two short, the trap the highfive comment
 *  calls out. */
export const HANDSHAKE_CONTACT_T = 0.32
const HS_SHAKE_START = HANDSHAKE_CONTACT_T
const HS_SHAKE_END = 0.72
const HS_SHAKES = 3   // "two or three shakes" — go with three

// Segment table: [end t, from, to, fromPalm, toPalm, kFrom, kTo, easing].
const HS_SEGS = [
  [0.20, HS_REST,  HS_REACH, HS_PALM_REST,  HS_PALM_REACH, HS_K.rest,  HS_K.reach, smooth],
  // closing the grip: decelerate into contact
  [HANDSHAKE_CONTACT_T, HS_REACH, HS_GRIP, HS_PALM_REACH, HS_PALM_GRIP, HS_K.reach, HS_K.grip, u => Math.pow(u, 1.5)],
  // shake window: the base pose holds at GRIP throughout — the oscillation is
  // layered on top in handshakePose, not here — so this segment is flat.
  [HS_SHAKE_END, HS_GRIP, HS_GRIP, HS_PALM_GRIP, HS_PALM_GRIP, HS_K.grip, HS_K.grip, u => u],
  [0.84, HS_GRIP, HS_RELEASE, HS_PALM_GRIP, HS_PALM_RELEASE, HS_K.grip, HS_K.release, smooth],
  [1.00, HS_RELEASE, HS_REST, HS_PALM_RELEASE, HS_PALM_REST, HS_K.release, HS_K.rest, smooth],
]

function hsBlend(t) {
  let i = 0, t0 = 0
  while (i < HS_SEGS.length - 1 && t >= HS_SEGS[i][0]) { t0 = HS_SEGS[i][0]; i++ }
  const [t1, a, b, pa, pb, ka, kb, easing] = HS_SEGS[i]
  const u = easing(clamp01(t1 === t0 ? 1 : (t - t0) / (t1 - t0)))
  return { v: lerpArr(a, b, u), palm: lerpArr(pa, pb, u), k: ka + (kb - ka) * u }
}

/** Shake amplitude, degrees. Zero at both ends of the window —
 *  sin(2*pi*N*u) is 0 at u=0 and u=1 for integer N — so it blends cleanly
 *  into the segments on either side without needing its own key. */
function shakeEnvelope(t) {
  if (t < HS_SHAKE_START || t > HS_SHAKE_END) return 0
  const u = (t - HS_SHAKE_START) / (HS_SHAKE_END - HS_SHAKE_START)
  return Math.sin(TAU * HS_SHAKES * u)
}

// The shake bob, solved rather than picked. Perturbing any single joint
// (elbow alone, tried first) moves the palm mostly vertically AT the exact
// pose it was solved for, but the two mirrored characters only stay in
// contact if the palm's LOCAL x (side-to-side) and z (reach) hold still —
// local y is free, since it doesn't get flipped by the 180-degree facing and
// so moves both characters together. A lone elbow bob leaks several
// centimetres of local x through the composed shoulder/arm/elbow rotation
// (measured: +-9deg of elbow alone opened an 8cm gap during the shake, even
// though the same swing barely moves the RAW hand position — see the
// investigation this comment is next to in git history). HS_BOB is the
// minimum-norm joint combination whose only first-order effect on the palm
// is vertical, found by numeric Jacobian at HS_GRIP and confirmed nonlinearly
// out to +-4cm of travel (residual drift under 0.4cm on both banned axes —
// see handshake-test.html's Jacobian probe). Six joints move by a fraction of
// a degree together instead of one joint by nine.
const HS_BOB = { shY: 0.362, shZ: -0.103, armX: -0.984, armY: 1.127, armZ: -0.560, elbow: 0.708 }
const HS_BOB_CM = 4   // vertical palm travel, each direction, at env = +-1

function handshakePose(t) {
  const { v, palm, k } = hsBlend(t)
  const [hipsYaw, lean, twist, shY, shZ, armX, armY, armZ, elbow, flex, dev] = v
  const env = shakeEnvelope(t)
  const bob = env * HS_BOB_CM
  const shYBob = shY + HS_BOB.shY * bob
  const shZBob = shZ + HS_BOB.shZ * bob
  const armXBob = armX + HS_BOB.armX * bob
  const armYBob = armY + HS_BOB.armY * bob
  const armZBob = armZ + HS_BOB.armZ * bob
  const elbowBob = elbow + HS_BOB.elbow * bob

  return {
    ...ANIM.STANDING,
    // No hips translation. The feet hang off the hips; sliding the pelvis
    // forward for a lean would drag them across the floor. All reach is
    // rotation, same rule highfive.js's clip follows.
    hips: [0, 0, 0],
    Hips:    [0, hipsYaw, 0],
    Spine02: [lean * 0.42, twist * 0.36, 0],
    Spine01: [lean * 0.30, twist * 0.34, 0],
    Spine:   [lean * 0.24, twist * 0.30, 0],
    // Torso turns in under the head, same trick highfivePose uses, so the
    // character keeps looking at the partner's face rather than their hand.
    neck:    [0, -8 * k, 0],
    Head:    [-3 * k, -13 * k, 1.5 * k],

    RightShoulder: [0, shYBob, shZBob],
    RightArm:      [armXBob, armYBob, armZBob],
    RightForeArm:  [0, elbowBob, 0],
    RightHand:     [flex, dev, 0],
    RightPalm:     palm,

    // Off arm counterbalances, mostly at the elbow, echoing the shake a
    // little so the pose doesn't look one-sided while the right arm pumps.
    LeftArm:      [-4 - 5 * k, -8, -99 + 2 * k],
    LeftForeArm:  [0, -16 - 20 * k - 3 * env, 0],
    LeftHand:     [5 + 3 * k, -4, 0],
  }
}

// 126 keys (a sample every 1/125 of the clip) puts a sample on every HS_SEGS
// boundary (0.20, 0.32, 0.72, 0.84 are all exact multiples of 1/125) — in
// particular the contact frame at t=0.32 — and, just as importantly, gives
// the three-cycle shake ~17 samples per cycle. Fewer keys undersample the
// oscillation: slerping between keyframes more than a few degrees apart on a
// sine cuts the corners, and with only ~3 samples/cycle (what 26 keys gives)
// the baked clip's hand drifts a few centimetres off the contact point at
// the extremes of each shake even though the raw pose function never does —
// caught by comparing the raw pose function against the mixer-played, baked
// AnimationClip in handshake-test.html's __scanClip.
const HANDSHAKE_SPEC = { fn: handshakePose, dur: 2.6, keys: 126, loop: false }

/** Registry in the {fn, dur, keys, loop} shape anim.js's own CLIPS table
 *  uses. An integrator can fold this straight in. */
export const registry = { handshake: HANDSHAKE_SPEC }

let _clip = null
/** Build (and memoise) the handshake AnimationClip. */
export function getClip() {
  if (!_clip) _clip = buildClipFromSpec('handshake', HANDSHAKE_SPEC)
  return _clip
}

// ---------------------------------------------------------------------------
// The spacing the clip is authored for — same derivation highfive.js uses.
// ---------------------------------------------------------------------------

/** Where the palm centre sits, in armature cm, at HANDSHAKE_CONTACT_T, on the
 *  character's own midline — measured off the clip itself (see measureContact
 *  below). Kept in sync with the pose above; if HS_GRIP moves, re-run the
 *  measurement and update these two. */
export const CONTACT_Y_CM = 101.0
export const CONTACT_Z_CM = 33.0

/** Root-to-root distance at contact, as a fraction of character height. */
export const HANDSHAKE_SPACING_RATIO = (2 * CONTACT_Z_CM) / MODEL_HEIGHT_CM

/** Root-to-root distance at contact, metres, for a CHARACTER_HEIGHT character. */
export const HANDSHAKE_SPACING = HANDSHAKE_SPACING_RATIO * CHARACTER_HEIGHT

export function spacingFor(height = CHARACTER_HEIGHT) {
  return HANDSHAKE_SPACING_RATIO * height
}

// ---------------------------------------------------------------------------
// Marks — identical shape to highfive.js's highfiveMarks.
// ---------------------------------------------------------------------------
const _ab = new THREE.Vector3()
const _mid = new THREE.Vector3()

function toVec(p) { return p && p.isVector3 ? p.clone() : new THREE.Vector3(p[0], p[1] ?? 0, p[2]) }

/**
 * Where the pair have to stand: on the line joining them, `spacing` apart,
 * centred on their midpoint, each facing the other.
 */
export function handshakeMarks(aPos, bPos, spacing = HANDSHAKE_SPACING) {
  const a = toVec(aPos), b = toVec(bPos)
  _ab.subVectors(b, a); _ab.y = 0
  if (_ab.lengthSq() < 1e-8) _ab.set(0, 0, 1)
  _ab.normalize()
  _mid.addVectors(a, b).multiplyScalar(0.5); _mid.y = 0
  const half = spacing * 0.5
  const markA = _mid.clone().addScaledVector(_ab, -half)
  const markB = _mid.clone().addScaledVector(_ab, half)
  return {
    a: { pos: markA, yaw: yawTowards(_ab) },
    b: { pos: markB, yaw: yawTowards(_ab.clone().negate()) },
    spacing,
  }
}

// ---------------------------------------------------------------------------
// The pair routine — walk -> settle -> shake, same shape as highfiveRoutine.
// ---------------------------------------------------------------------------
const shortestAngle = d => ((d % TAU) + TAU + Math.PI) % TAU - Math.PI

function turn(g, yaw, max) {
  const d = shortestAngle(yaw - g.rotation.y)
  if (Math.abs(d) <= max) { g.rotation.y = yaw; return true }
  g.rotation.y += Math.sign(d) * max
  return false
}

/** Clip rate that keeps the feet planted at a given ground speed. Same
 *  formula as highfive.js's walkScale — WALK_CYCLE_METERS is a rig fact, not
 *  a highfive fact, so this is not importing anything highfive-specific. */
function walkScale(speed, height) {
  const perCycle = ANIM.WALK_CYCLE_METERS * (height / CHARACTER_HEIGHT)
  return speed * ANIM.getClip('walk').duration / perCycle
}

/** Start the handshake clip on `root`, crossfading in from whatever the
 *  character's mixer is currently playing. Not registered in anim.js, so it
 *  can't go through ANIM.crossfade by name — this does the same thing by
 *  hand: same mixer (ANIM.getMixer caches per-object), same crossFadeFrom. */
export function playHandshake(root, fade = 0.16) {
  const idle = ANIM.makeAction(root, 'idle')  // whatever's "current" is one of anim.js's own actions
  const mixer = ANIM.getMixer(root)
  const clip = getClip()
  const action = mixer.clipAction(clip)
  action.setLoop(THREE.LoopOnce, 1)
  action.clampWhenFinished = true
  action.reset()
  action.enabled = true
  action.setEffectiveWeight(1)
  action.crossFadeFrom(idle, fade, false)
  action.play()
  return action
}

/**
 * @param {{group:THREE.Object3D, root:THREE.Object3D, height:number}} a
 * @param {{group:THREE.Object3D, root:THREE.Object3D, height:number}} b
 */
export function handshakeRoutine(a, b, {
  speed = 1.15,
  turnRate = 5.0,
  settle = 0.28,
  arriveEps = 0.006,
  height = CHARACTER_HEIGHT,
} = {}) {
  const spacing = spacingFor(height)
  const marks = handshakeMarks(a.group.position, b.group.position, spacing)
  const legs = [
    { c: a, mark: marks.a, arrived: false },
    { c: b, mark: marks.b, arrived: false },
  ]
  let phase = 'walk', clock = 0

  for (const l of legs) ANIM.crossfade(l.c.root, 'walk', 0.2, { timeScale: walkScale(speed, height) })

  function step(dt) {
    if (phase === 'walk') {
      let all = true
      for (const l of legs) {
        const g = l.c.group
        const d = _ab.subVectors(l.mark.pos, g.position); d.y = 0
        const dist = d.length()
        if (dist > arriveEps) {
          all = false
          const s = Math.min(dist, speed * dt)
          g.position.addScaledVector(d.normalize(), s)
          turn(g, yawTowards(d), turnRate * dt)
        } else if (!l.arrived) {
          g.position.copy(l.mark.pos)
          l.arrived = true
          ANIM.crossfade(l.c.root, 'idle', 0.25)
        }
        if (l.arrived && !turn(g, l.mark.yaw, turnRate * dt)) all = false
      }
      if (all) { phase = 'settle'; clock = 0 }
    } else if (phase === 'settle') {
      clock += dt
      if (clock >= settle) {
        // Same frame, both of them — the whole sync story.
        for (const l of legs) playHandshake(l.c.root)
        phase = 'shake'; clock = 0
      }
    } else if (phase === 'shake') {
      clock += dt
      if (clock >= getClip().duration) phase = 'done'
    }
    for (const l of legs) ANIM.update(l.c.root, dt)
    return phase
  }

  return {
    step,
    marks,
    spacing,
    get phase() { return phase },
    contactAt: getClip().duration * HANDSHAKE_CONTACT_T,
  }
}

// ---------------------------------------------------------------------------
// Measurement
// ---------------------------------------------------------------------------
// Palm point/hand point are generic (side, height), not highfive-specific,
// so they're reused straight from highfive.js rather than rewritten — a
// handshake's contact is palm-to-palm just like a high five's, only lower and
// shorter.

/** Where the right palm sits at contact, in the scratch rig (character
 *  space, armature cm) — used to derive CONTACT_Y_CM/CONTACT_Z_CM above.
 *  Exported so a test page can re-run the measurement after a pose edit. */
export function measureContact() {
  const rig = makeRig()
  ANIM.applyPose(rig.Hips, handshakePose(HANDSHAKE_CONTACT_T))
  return palmPoint(rig.Hips, 'Right', MODEL_HEIGHT_CM)
}

/** Same idea as measureContact, but against an arbitrary pose fragment
 *  merged over STANDING — a tuning knob for finding HS_GRIP itself, not part
 *  of the authored clip. */
export function measurePose(fragment) {
  const rig = makeRig()
  ANIM.applyPose(rig.Hips, { ...ANIM.STANDING, ...fragment })
  return { palm: palmPoint(rig.Hips, 'Right', MODEL_HEIGHT_CM), hand: handPoint(rig.Hips, 'Right') }
}

export { palmPoint, handPoint }
