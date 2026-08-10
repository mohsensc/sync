// Procedural animation for the clay character rig.
//
// The rig is not a clean Mixamo rig, so read this before editing:
//
//   * The spine chain is INVERTED relative to its names:
//       Hips > Spine02 > Spine01 > Spine > neck > Head
//     Spine02 is the lowest (belly), Spine is the chest. Fold the torso from
//     Spine02 first if you want it to read as a spine and not a neck hinge.
//
//   * The bind pose is a T-pose with ~18 degrees of arm elevation, not an
//     A-pose. Arms point along +/-X. Getting them to hang takes ~100 degrees,
//     which is why every standing pose here carries a big Z on the arms.
//
//   * Every bone has a non-identity rest rotation (Hips 34 deg, thighs 137
//     deg, shoulders 90 deg). Writing absolute euler angles onto these bones
//     tears the character apart. Everything below is a DELTA composed against
//     the bind pose.
//
// AUTHORING SPACE
// Poses are written as degrees about the character's own axes, measured from
// the bind pose:
//
//   +X = character's left   +Y = up   +Z = forward (the way it faces)
//
//   rot X positive  -> tips the top of a bone forward
//                      spine folds forward; a hanging limb swings BACKWARD
//   rot Y positive  -> yaw to the character's left; on a hanging limb, twist
//   rot Z positive  -> roll toward the character's left
//
// Euler order is XYZ, which three applies Z first, then Y, then X. That
// ordering is deliberate: on an arm, Z drops it to the side, Y then twists it
// about its own length, and X finally swings it fore/aft. Write arms as
// [swing, twist, drop].
//
// Deltas are applied in the parent's BIND frame, so a child's axes are carried
// along by whatever the parent is doing. Bending a knee about +X stays a knee
// bend no matter where the thigh has swung to. But it also means you author
// relative to the T-pose: in bind, a forearm points sideways along X, so elbow
// flexion is a Y rotation, not an X one. See ELBOW below.
//
// Mirroring left to right = negate the Y and Z components, swap the names.
//
// Units: bone translations in this GLB are CENTIMETRES (the Armature node
// carries a 0.01 scale). Hips.position offsets below are therefore in cm.

import * as THREE from 'three'

const D2R = Math.PI / 180
const TAU = Math.PI * 2

// ---------------------------------------------------------------------------
// Bind data, read straight out of character.glb.
//   q  = the bone's own rest rotation (local)
//   pw = the accumulated rest rotation of everything above it (parent world)
//   t  = rest translation, cm
// ---------------------------------------------------------------------------
export const BIND = {
  Hips:          { q:[0.294792,0.052569,-0.0,0.954114],        pw:[0,0,0,1],                                  t:[0.04807,70.843491,1.023557] },
  Spine02:       { q:[-0.28252,-0.052776,0.001076,0.957808],   pw:[0.294792,0.052569,-0.0,0.954114],          t:[0.342765,10.376469,-6.683912] },
  Spine01:       { q:[0.0,0.0,-0.0,1],                         pw:[0.012855,-0.00032,0.00032,0.999917],       t:[0.0,12.347582,0.000004] },
  Spine:         { q:[-0.013562,0.004153,-0.004252,0.99989],   pw:[0.012855,-0.00032,0.00032,0.999917],       t:[0.0,12.347591,0.0] },
  neck:          { q:[0.013105,-0.004556,0.004651,0.999893],   pw:[-0.000707,0.003883,-0.003883,0.999985],    t:[-0.091002,9.655903,0.252733] },
  Head:          { q:[0.188871,-0.000005,-0.00027,0.982002],   pw:[0.012397,-0.000721,0.000721,0.999923],     t:[0.0,6.802083,0.0] },

  LeftShoulder:  { q:[0.498149,0.502533,-0.497957,0.501345],   pw:[-0.000707,0.003883,-0.003883,0.999985],    t:[3.631854,1.728425,-0.097043] },
  LeftArm:       { q:[-0.160455,-0.161868,-0.006949,0.973655], pw:[0.497805,0.502186,-0.502186,0.497805],     t:[0.0,14.577729,0.0] },
  LeftForeArm:   { q:[-0.069731,-0.098088,0.079818,0.989518],  pw:[0.320038,0.492415,-0.492415,0.642364],     t:[-0.000007,20.984289,-0.000014] },
  LeftHand:      { q:[-0.062587,-0.083543,0.062246,0.992587],  pw:[0.262894,0.433037,-0.433037,0.74555],      t:[0,21.372713,-0.000009] },

  RightShoulder: { q:[0.498056,-0.502626,0.50578,0.493451],    pw:[-0.000707,0.003883,-0.003883,0.999985],    t:[-3.540852,0.693548,-0.15569] },
  RightArm:      { q:[-0.188358,0.190086,-0.003381,0.963523],  pw:[0.497711,-0.502278,0.502278,0.497711],     t:[0.0,14.146457,0.0] },
  RightForeArm:  { q:[-0.027928,0.050879,-0.05822,0.996615],   pw:[0.29203,-0.482274,0.482274,0.670479],      t:[-0.000004,21.137957,0.000001] },
  RightHand:     { q:[-0.084153,0.105619,-0.069674,0.988387],  pw:[0.275857,-0.442996,0.442995,0.728981],     t:[0.000003,20.520437,-0.000012] },

  LeftUpLeg:     { q:[0.929758,0.043546,-0.037352,0.363673],   pw:[0.294792,0.052569,-0.0,0.954114],          t:[10.445539,-4.796827,5.667562] },
  LeftLeg:       { q:[0.105594,0.060138,0.05293,0.991177],     pw:[0.99234,0.071677,-0.071677,0.070611],      t:[0.000002,27.87454,-0.000001] },
  LeftFoot:      { q:[-0.359025,0.002159,0.01256,0.933241],    pw:[0.999145,0.015198,-0.015198,-0.035314],    t:[-0.000002,26.013973,0.000001] },
  LeftToeBase:   { q:[-0.437954,-0.006345,-0.003084,0.898969], pw:[0.945346,0.007014,-0.007014,0.325919],     t:[-0.000002,9.950005,0.0] },

  RightUpLeg:    { q:[0.923589,-0.048798,0.137817,0.354414],   pw:[0.294792,0.052569,-0.0,0.954114],          t:[-10.788303,-5.579607,3.601071] },
  RightLeg:      { q:[0.096667,-0.051734,-0.045058,0.99295],   pw:[0.992932,-0.068555,0.068555,0.06845],      t:[0.0,28.413073,0.000005] },
  RightFoot:     { q:[-0.358062,0.006774,-0.00771,0.933641],   pw:[0.999184,-0.020247,0.020247,-0.028474],    t:[-0.000001,24.673157,0.000001] },
  RightToeBase:  { q:[-0.432166,0.016418,0.00787,0.90161],     pw:[0.943094,-0.018642,0.018642,0.331478],     t:[-0.000001,10.256929,0.000001] },
}

export const BONES = Object.keys(BIND)

// head_end and headfront exist in the skin but are shape helpers with absurd
// offsets (head_end sits 44cm above the head). Never drive them.

// Distance one full walk cycle covers, in bind-pose metres. A walker that
// translates at this rate per cycle keeps its feet planted. Scale it by
// whatever scale factor you applied to the character.
export const WALK_CYCLE_METERS = 0.86

// ---------------------------------------------------------------------------
// Pose -> local quaternion
// ---------------------------------------------------------------------------
const _e = new THREE.Euler(0, 0, 0, 'XYZ')
const _d = new THREE.Quaternion()
const _pw = new THREE.Quaternion()
const _pwi = new THREE.Quaternion()
const _qb = new THREE.Quaternion()
const _out = new THREE.Quaternion()

// world_final = delta * world_bind, expressed back in the bone's local space:
//   local_final = inv(pw) * delta * pw * q_bind
function localQuat(bone, rx, ry, rz, out = _out) {
  const b = BIND[bone]
  _e.set(rx * D2R, ry * D2R, rz * D2R, 'XYZ')
  _d.setFromEuler(_e)
  _pw.set(b.pw[0], b.pw[1], b.pw[2], b.pw[3])
  _pwi.copy(_pw).invert()
  _qb.set(b.q[0], b.q[1], b.q[2], b.q[3])
  return out.copy(_pwi).multiply(_d).multiply(_pw).multiply(_qb)
}

/** Snap a character to a static pose. Handy for debugging and for parking a
 *  character in a held state without running a mixer. */
export function applyPose(root, pose) {
  for (const name of BONES) {
    const r = pose[name]
    if (!r) continue
    const bone = root.getObjectByName(name)
    if (!bone) continue
    localQuat(name, r[0], r[1], r[2], bone.quaternion)
  }
  if (pose.hips) {
    const h = root.getObjectByName('Hips')
    if (h) h.position.set(
      BIND.Hips.t[0] + pose.hips[0],
      BIND.Hips.t[1] + pose.hips[1],
      BIND.Hips.t[2] + pose.hips[2])
  }
  root.updateMatrixWorld(true)
  return root
}

// ---------------------------------------------------------------------------
// Small maths helpers used by the pose functions
// ---------------------------------------------------------------------------
const wrap = p => ((p % 1) + 1) % 1

/** Periodic raised cosine. 1 at centre, 0 outside width, zero slope at the
 *  edges so it never puts a corner in the curve. */
function bump(p, centre, width) {
  let d = wrap(p - centre + 0.5) - 0.5
  const h = width * 0.5
  if (Math.abs(d) >= h) return 0
  return 0.5 * (1 + Math.cos(Math.PI * d / h))
}
const cos = (p, k = 1) => Math.cos(TAU * k * p)
const sin = (p, k = 1) => Math.sin(TAU * k * p)
/** Smoothstep, for one-shot clips where a value has to ease from a to b. */
function ease(t, a, b) {
  const u = Math.max(0, Math.min(1, t))
  return a + (b - a) * u * u * (3 - 2 * u)
}
const mix = (a, b, t) => a + (b - a) * t

/** Merge pose fragments left to right. Later wins. */
function pose(...parts) {
  const o = {}
  for (const p of parts) if (p) for (const k in p) o[k] = p[k]
  return o
}

/** Mirror a pose across the character's YZ plane. */
export function mirrorPose(p) {
  const o = {}
  for (const k in p) {
    if (k === 'hips') { o.hips = [-p.hips[0], p.hips[1], p.hips[2]]; continue }
    const swapped = k.startsWith('Left') ? 'Right' + k.slice(4)
                  : k.startsWith('Right') ? 'Left' + k.slice(5) : k
    const v = p[k]
    o[swapped] = [v[0], -v[1], -v[2]]
  }
  return o
}

// ---------------------------------------------------------------------------
// Base poses
// ---------------------------------------------------------------------------

// Arms down at the sides. This is the fix for the T-pose. ~100 deg of Z drops
// the arm from horizontal to hanging with a little clearance from the hip.
// ELBOW: in bind the forearm points sideways along X, so flexion (hand moves
// forward) is a rotation about -Y on the left and +Y on the right.
const ARMS_DOWN = {
  LeftShoulder: [0, 0, -2],   RightShoulder: [0, 0, 2],
  LeftArm:      [-4, -8, -99], RightArm:     [-4, 8, 99],
  LeftForeArm:  [0, -16, 0],  RightForeArm:  [0, 16, 0],
  LeftHand:     [0, -6, 4],   RightHand:     [0, 6, -4],
}

const LEGS_STRAIGHT = {
  LeftUpLeg: [0, 0, 0], LeftLeg: [0, 0, 0], LeftFoot: [0, 0, 0], LeftToeBase: [0, 0, 0],
  RightUpLeg: [0, 0, 0], RightLeg: [0, 0, 0], RightFoot: [0, 0, 0], RightToeBase: [0, 0, 0],
}

const SPINE_NEUTRAL = {
  Hips: [0, 0, 0], Spine02: [0, 0, 0], Spine01: [0, 0, 0], Spine: [0, 0, 0],
  neck: [0, 0, 0], Head: [0, 0, 0],
}

const STAND = pose(SPINE_NEUTRAL, LEGS_STRAIGHT, ARMS_DOWN, { hips: [0, 0, 0] })

// Seated at a desk. Thigh forward and slightly down, shin near vertical, hips
// dropped to seat height. Every seated clip starts from this so that sit ->
// type -> read crossfade without the legs popping.
//
// Angles compose down the chain: the pelvis tips back 12, so the thigh's own
// -70 lands at -82 in world, and the knee's +80 has to undo all of it to leave
// the shin roughly vertical.
export const SEATED = pose(STAND, {
  hips:      [0, -25, -7],
  Hips:      [-12, 0, 0],
  Spine02:   [7, 0, 0], Spine01: [3, 0, 0], Spine: [2, 0, 0],
  LeftUpLeg: [-70, 5, 4],  RightUpLeg: [-70, -5, -4],
  LeftLeg:   [80, 0, 0],   RightLeg:   [80, 0, 0],
  LeftFoot:  [6, 0, 0],    RightFoot:  [6, 0, 0],
  LeftArm:   [-14, -8, -92], RightArm: [-14, 8, 92],
  LeftForeArm: [0, -52, 0],  RightForeArm: [0, 52, 0],
})

export const STANDING = STAND

// ---------------------------------------------------------------------------
// Clip pose functions. Each takes normalised time t in [0,1] and returns a
// full pose. Looping clips must satisfy f(1) === f(0), which the periodic
// helpers give for free.
//
// Every clip emits every bone. That is deliberate: if a clip left the legs out,
// crossfading into it would let the legs drift back toward the T-pose bind
// while the weight ramped.
// ---------------------------------------------------------------------------

// --- idle ------------------------------------------------------------------
// Slow weight shift on a 1x cycle, breathing on a 2x cycle so the two never
// line up and it does not read as a metronome.
function idlePose(t) {
  const s = sin(t)                 // weight shift
  const br = sin(t, 2)             // breath
  const sway = 2.2 * s
  return pose(STAND, {
    hips:    [1.5 * s, -0.35 + 0.35 * cos(t, 2) * 0.5, 0],
    Hips:    [0, 1.2 * s, sway],
    Spine02: [0.6 * br, -0.7 * s, -0.9 * s],
    Spine01: [-0.5 * br, -0.5 * s, -0.6 * s],
    Spine:   [-1.4 * br, -0.4 * s, -0.5 * s],   // chest lifts on the inhale
    neck:    [0.6 * br, 0.5 * s, 0],
    Head:    [-0.8 + 1.0 * sin(t + 0.15), 1.8 * sin(t + 0.1), -0.8 * s],
    LeftArm:  [-4 + 1.6 * s, -8, -99 + 1.4 * s],
    RightArm: [-4 + 1.6 * s, 8, 99 + 1.4 * s],
    LeftForeArm:  [0, -16 - 2 * br, 0],
    RightForeArm: [0, 16 + 2 * br, 0],
  })
}

// --- walk ------------------------------------------------------------------
// One clip cycle = two steps. Leg phase p: 0 is heel strike, 0.5 is toe-off
// and the other foot's heel strike.
function legPose(p) {
  // Thigh swings forward at contact, extends behind through stance.
  // Forward is -X on a downward-pointing bone.
  const thigh = -24 * cos(p)

  // Knee: nearly straight through stance with a small loading dip just after
  // contact, then a big flexion in swing to get the foot off the floor.
  const knee = 3
    + 11 * bump(p, 0.14, 0.26)
    + 57 * bump(p, 0.72, 0.34)

  // Ankle: slight toes-up at heel strike, roll flat, plantarflex hard at
  // toe-off, dorsiflex again in swing for clearance. +X is toes down.
  const foot = -7 * bump(p, 0.0, 0.26)
    + 21 * bump(p, 0.47, 0.24)
    - 9 * bump(p, 0.74, 0.38)

  // Toes hinge up as the heel leaves the floor. -X is toes up.
  const toe = -32 * bump(p, 0.52, 0.22) + 6 * bump(p, 0.05, 0.18)

  return { thigh, knee, foot, toe }
}

function walkPose(t) {
  const L = legPose(t)             // left leg strikes at t=0
  const R = legPose(t + 0.5)       // right leg is half a cycle behind

  // Contralateral: the left arm swings back while the left leg swings forward.
  const armL = 19 * cos(t)
  const armR = -19 * cos(t)
  const elbowL = 18 + 9 * bump(t, 0.5, 0.5)
  const elbowR = 18 + 9 * bump(t, 0.0, 0.5)

  return pose(STAND, {
    // Two bobs per cycle, lowest at each double-support, plus weight shifting
    // laterally over whichever foot is planted.
    hips: [1.7 * sin(t), -1.5 * cos(t, 2), 0],
    Hips: [1.5, -4.5 * cos(t), 3.0 * cos(t)],

    // Torso counter-rotates against the pelvis, which is what stops a walk
    // from looking like a wind-up toy.
    Spine02: [1.5, 2.2 * cos(t), -1.2 * cos(t)],
    Spine01: [1.0, 2.6 * cos(t), -0.8 * cos(t)],
    Spine:   [0.5, 3.0 * cos(t), -0.6 * cos(t)],
    neck:    [-1.0, -1.5 * cos(t), 0],
    Head:    [-1.5, -2.4 * cos(t), 0.8 * cos(t)],

    LeftUpLeg:  [L.thigh, 2, 3],  LeftLeg:  [L.knee, 0, 0],
    LeftFoot:   [L.foot, 0, 0],   LeftToeBase: [L.toe, 0, 0],
    RightUpLeg: [R.thigh, -2, -3], RightLeg: [R.knee, 0, 0],
    RightFoot:  [R.foot, 0, 0],   RightToeBase: [R.toe, 0, 0],

    LeftShoulder: [0, 0, -2 + 1.5 * cos(t)],
    RightShoulder: [0, 0, 2 + 1.5 * cos(t)],
    LeftArm:  [armL - 4, -10, -97],
    RightArm: [armR - 4, 10, 97],
    LeftForeArm:  [0, -elbowL, 0],
    RightForeArm: [0, elbowR, 0],
    LeftHand:  [0, -8, 4], RightHand: [0, 8, -4],
  })
}

// --- sit -------------------------------------------------------------------
// One shot, standing to seated. Clamps on the last frame so the character can
// hold the desk pose indefinitely.
function sitPose(t) {
  // Slight squat before the weight drops, then settle with a small overshoot.
  const drop = ease((t - 0.08) / 0.62, 0, 1)
  const settle = 1 + 0.06 * Math.sin(TAU * Math.max(0, (t - 0.62)) * 1.4) * (1 - t)
  const k = Math.min(1, drop * settle)
  const lean = 14 * bump(t, 0.45, 0.7)     // leans forward on the way down

  const out = {}
  for (const bone of BONES) {
    const a = STAND[bone], b = SEATED[bone]
    out[bone] = [mix(a[0], b[0], k), mix(a[1], b[1], k), mix(a[2], b[2], k)]
  }
  out.hips = [0, mix(0, SEATED.hips[1], k), mix(0, SEATED.hips[2], k)]
  out.Spine02 = [out.Spine02[0] + lean, out.Spine02[1], out.Spine02[2]]
  out.Spine01 = [out.Spine01[0] + lean * 0.4, out.Spine01[1], out.Spine01[2]]
  out.Head = [out.Head[0] - lean * 0.5, out.Head[1], out.Head[2]]
  return out
}

// --- type ------------------------------------------------------------------
// Seated loop. Hands alternate at 4x the base rate, head dips once a cycle.
function typePose(t) {
  const a = sin(t, 4), b = sin(t + 0.5, 4)
  const dip = bump(t, 0.78, 0.3)
  return pose(SEATED, {
    Spine02: [11, 0, 0], Spine01: [4, 0, 0], Spine: [3, 0, 0],
    neck: [7, 0, 0],
    Head: [9 + 7 * dip, 3 * sin(t), 0],
    LeftArm:  [-30, -14, -84], RightArm: [-30, 14, 84],
    LeftForeArm:  [0, -74 + 2 * a, 0], RightForeArm: [0, 74 - 2 * b, 0],
    LeftHand:  [4 * a, -14, 10 + 5 * a],
    RightHand: [4 * b, 14, -10 - 5 * b],
  })
}

// --- highfive --------------------------------------------------------------
// One shot. Right arm comes up and reaches across, contact at t=0.5, recoil,
// return. Play the mirrored version on the partner with the same timing and
// the hands meet.
function highfivePose(t) {
  const up = ease(t / 0.42, 0, 1)             // raise
  const back = ease((t - 0.62) / 0.38, 0, 1)  // return
  const k = up * (1 - back)
  const contact = bump(t, 0.5, 0.16)          // the little jolt on impact
  const anticip = bump(t, 0.3, 0.3)

  const armZ = mix(99, 26, k) - 8 * contact
  const armX = mix(-4, -26, k) + 6 * contact
  const elbow = mix(16, 44, k) - 18 * contact

  return pose(STAND, {
    hips: [0, -1.5 * anticip, 1.5 * k],
    Hips: [0, -5 * k, 0],
    Spine02: [-2 * k, -7 * k, 0],
    Spine01: [-1 * k, -6 * k, 0],
    Spine:   [-2 * k, -5 * k, 0],
    Head:    [-4 * k, -9 * k, 0],
    RightShoulder: [0, 0, 2 + 9 * k],
    RightArm:      [armX, 12 + 10 * k, armZ],
    RightForeArm:  [0, elbow, 0],
    RightHand:     [0, 10 + 16 * k, -6],
    LeftArm:       [-4 + 6 * k, -8, -99 + 5 * k],
    LeftForeArm:   [0, -16 - 8 * k, 0],
    // Weight shifts onto the front foot as it reaches.
    RightUpLeg: [-6 * k, -2, -3], RightLeg: [8 * k, 0, 0],
    LeftUpLeg:  [4 * k, 2, 3],    LeftLeg:  [3 * k, 0, 0],
  })
}

// --- drink -----------------------------------------------------------------
// Hand to mouth and back, holding a cup. Loops, with a long low dwell so it
// does not look frantic if left running.
function drinkPose(t) {
  const raise = bump(t, 0.5, 0.9)             // up and back down
  const sip = bump(t, 0.5, 0.28)              // head tilt at the top
  const k = raise
  return pose(STAND, {
    Hips: [0, -3 * k, 0],
    Spine02: [1 * k, -3 * k, 0], Spine01: [0, -3 * k, 0], Spine: [-1 * k, -3 * k, 0],
    neck: [-2 * sip, 0, 0],
    Head: [-9 * sip, -5 * k, 0],
    RightShoulder: [0, 0, 2 + 5 * k],
    RightArm:     [mix(-4, -34, k), mix(8, 34, k), mix(99, 68, k)],
    RightForeArm: [0, mix(16, 122, k), 0],
    RightHand:    [0, mix(6, 26, k), mix(-4, -18, k)],
    LeftArm:      [-4, -8, -99],
    LeftForeArm:  [0, -16 - 4 * k, 0],
  })
}

// --- read ------------------------------------------------------------------
// Standing, both hands out front holding something, head down. The page turn
// is a short flick of the right hand once per cycle.
function readPose(t) {
  const turn = bump(t, 0.82, 0.16)
  const breath = sin(t, 2)
  return pose(STAND, {
    hips: [0, -1, 0],
    Spine02: [7, 0, 0], Spine01: [3, 0, 0], Spine: [2 - 0.8 * breath, 0, 0],
    neck: [9, 0, 0],
    Head: [15, 2.5 * sin(t), 0],
    LeftShoulder: [0, 0, 3], RightShoulder: [0, 0, -3],
    LeftArm:  [-38, -20, -74], RightArm: [-38, 20, 74],
    LeftForeArm:  [0, -86, 0],
    RightForeArm: [0, 86 - 26 * turn, 0],
    LeftHand:  [0, -18, 14],
    RightHand: [0, 18 + 30 * turn, -14 - 20 * turn],
  })
}

// --- sleep -----------------------------------------------------------------
// Slumped forward over the desk, head down on the arms. The idle-agent state.
// The fold is spread across all three spine bones so it does not hinge at one
// joint. Remember Spine02 is the lowest.
function sleepPose(t) {
  const breath = sin(t)
  return pose(SEATED, {
    hips: [0, -27, -4],
    Hips: [6, 0, 0],
    Spine02: [26 + 0.9 * breath, 0, 2],
    Spine01: [16 + 0.7 * breath, 0, 1],
    Spine:   [12 + 0.5 * breath, 2, 1],
    neck:    [16, 0, 0],
    Head:    [20, 6, 3],
    LeftShoulder: [0, 0, 6], RightShoulder: [0, 0, -6],
    LeftArm:  [-46, -22, -66], RightArm: [-46, 22, 66],
    LeftForeArm:  [0, -96, 0], RightForeArm: [0, 96, 0],
    LeftHand:  [0, -20, 16], RightHand: [0, 20, -16],
  })
}

// --- wave ------------------------------------------------------------------
// Right arm up and out, hand oscillating from the forearm. Loop.
function wavePose(t) {
  const osc = sin(t, 3)
  const weight = sin(t)
  return pose(STAND, {
    hips: [0.8 * weight, 0, 0],
    Hips: [0, -3, 1.5 * weight],
    Spine02: [0, -3, -1 * weight], Spine01: [0, -3, 0], Spine: [-1, -4, 0],
    Head: [-2, -7 + 2 * osc, 1.5 * weight],
    RightShoulder: [0, 0, -12],
    RightArm:     [-12, 26, 18],
    RightForeArm: [0, 34 + 5 * osc, 0],
    RightHand:    [0, 6, -20 * osc],
    LeftArm:      [-4 + 1.5 * weight, -8, -99],
    LeftForeArm:  [0, -18, 0],
  })
}

// ---------------------------------------------------------------------------
// Clip table
// ---------------------------------------------------------------------------
const CLIPS = {
  idle:     { fn: idlePose,     dur: 4.6,  keys: 12, loop: true },
  walk:     { fn: walkPose,     dur: 1.05, keys: 18, loop: true },
  sit:      { fn: sitPose,      dur: 1.5,  keys: 14, loop: false },
  type:     { fn: typePose,     dur: 2.0,  keys: 20, loop: true },
  highfive: { fn: highfivePose, dur: 1.5,  keys: 18, loop: false },
  drink:    { fn: drinkPose,    dur: 3.4,  keys: 16, loop: true },
  read:     { fn: readPose,     dur: 5.0,  keys: 16, loop: true },
  sleep:    { fn: sleepPose,    dur: 5.5,  keys: 10, loop: true },
  wave:     { fn: wavePose,     dur: 2.2,  keys: 18, loop: true },
}

export const CLIP_NAMES = Object.keys(CLIPS)
export const ONE_SHOT = new Set(['sit', 'highfive'])
/** Clips that leave the character seated. Useful for deciding what to play next. */
export const SEATED_CLIPS = new Set(['sit', 'type', 'sleep'])

function buildClip(name, spec, { mirror = false } = {}) {
  const { fn, dur, keys, loop } = spec
  // A looping clip's last key repeats the first, so it needs one extra sample.
  const n = loop ? keys + 1 : keys
  const times = new Float32Array(n)
  const rot = {}
  for (const b of BONES) rot[b] = new Float32Array(n * 4)
  const hips = new Float32Array(n * 3)
  const q = new THREE.Quaternion()

  for (let i = 0; i < n; i++) {
    const t01 = loop ? i / keys : (n === 1 ? 0 : i / (n - 1))
    times[i] = t01 * dur
    let p = fn(t01)
    if (mirror) p = mirrorPose(p)
    for (const b of BONES) {
      const r = p[b] || [0, 0, 0]
      localQuat(b, r[0], r[1], r[2], q)
      rot[b][i * 4 + 0] = q.x; rot[b][i * 4 + 1] = q.y
      rot[b][i * 4 + 2] = q.z; rot[b][i * 4 + 3] = q.w
    }
    const h = p.hips || [0, 0, 0]
    hips[i * 3 + 0] = BIND.Hips.t[0] + h[0]
    hips[i * 3 + 1] = BIND.Hips.t[1] + h[1]
    hips[i * 3 + 2] = BIND.Hips.t[2] + h[2]
  }

  const tracks = [new THREE.VectorKeyframeTrack('Hips.position', times, hips)]
  for (const b of BONES) tracks.push(new THREE.QuaternionKeyframeTrack(b + '.quaternion', times, rot[b]))

  const clip = new THREE.AnimationClip(mirror ? name + 'Mirror' : name, dur, tracks)
  clip.userData = { loop, oneShot: !loop }
  return clip
}

let _cache = null
/** Build (and memoise) every clip. Returns { name: AnimationClip }. */
export function createClips() {
  if (_cache) return _cache
  _cache = {}
  for (const name in CLIPS) _cache[name] = buildClip(name, CLIPS[name])
  // Paired action: same timing, opposite arm, so two characters facing each
  // other can play highfive / highfiveMirror from the same start time.
  _cache.highfiveMirror = buildClip('highfive', CLIPS.highfive, { mirror: true })
  return _cache
}

export function getClip(name) {
  const c = createClips()[name]
  if (!c) throw new Error(`anim: no clip "${name}". Have: ${Object.keys(createClips()).join(', ')}`)
  return c
}

// ---------------------------------------------------------------------------
// Playback helpers
// ---------------------------------------------------------------------------
const RIGS = new WeakMap()

/** Mixer for a character, created on first use and cached on the object. */
export function getMixer(obj) {
  let r = RIGS.get(obj)
  if (!r) { r = { mixer: new THREE.AnimationMixer(obj), current: null, actions: new Map() }; RIGS.set(obj, r) }
  return r.mixer
}

function rigOf(obj) { getMixer(obj); return RIGS.get(obj) }

/**
 * Configured AnimationAction for a character + clip name.
 * One-shots clamp on their last frame so sit/highfive hold their end pose.
 */
export function makeAction(obj, name, { timeScale = 1 } = {}) {
  const rig = rigOf(obj)
  let a = rig.actions.get(name)
  if (!a) {
    const clip = getClip(name)
    a = rig.mixer.clipAction(clip)
    if (clip.userData.oneShot) { a.setLoop(THREE.LoopOnce, 1); a.clampWhenFinished = true }
    else a.setLoop(THREE.LoopRepeat, Infinity)
    rig.actions.set(name, a)
  }
  a.timeScale = timeScale
  return a
}

/**
 * Blend from whatever is playing into `name`. Returns the incoming action.
 * Restarts one-shots so sit/highfive can be re-triggered.
 */
export function crossfade(obj, name, duration = 0.35, opts = {}) {
  const rig = rigOf(obj)
  const next = makeAction(obj, name, opts)
  const prev = rig.current

  if (prev === next && !ONE_SHOT.has(name)) return next

  next.enabled = true
  next.setEffectiveWeight(1)
  if (ONE_SHOT.has(name) || prev === next) next.reset()

  if (prev && prev !== next) {
    // Sync the phase on cycles of similar shape so the feet do not teleport.
    if (name === 'walk' && prev.getClip().name === 'walk') next.time = prev.time
    next.crossFadeFrom(prev, duration, false)
  }
  next.play()
  rig.current = next
  return next
}

/** Advance one character's mixer. */
export function update(obj, dt) { getMixer(obj).update(dt) }

/** Currently playing clip name, or null. */
export function currentClip(obj) {
  const r = RIGS.get(obj)
  return r && r.current ? r.current.getClip().name : null
}

export function dispose(obj) {
  const r = RIGS.get(obj)
  if (!r) return
  r.mixer.stopAllAction()
  r.mixer.uncacheRoot(obj)
  RIGS.delete(obj)
}
