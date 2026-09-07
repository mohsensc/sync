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
// HANDS AND FOREARMS ARE THE EXCEPTION. They do not take euler triples. See
// WRIST FRAME further down: a hand is [flex, dev, twist] about the wrist's own
// axes, and a forearm takes an optional 4th number, a roll about its own
// length. Writing a hand as a euler triple is what made the wrists read wrong.
//
// Mirroring left to right = negate the Y and Z components, swap the names.
// That rule holds for the wrist frame too, and for the forearm roll.
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
// WRIST FRAME
// ---------------------------------------------------------------------------
// A hand is not an euler triple. The three axes a wrist actually turns about
// are nowhere near the coordinate axes on this rig: the forearm points 29 deg
// above +X and the hand a further 10 deg past that. Feed a hand a plain
// [0, y, 0] and roughly half of it comes out as roll about the forearm — a
// motion the wrist has no joint for. That is what made every hand here read
// wrong; `read` was smuggling 33 degrees of it into a page turn.
//
// So hands are written as degrees about their own axes:
//
//   [flex, dev, twist]
//
//   flex  + curls the hand palm-ward. In the bind T-pose that swings the
//         fingertips backward (-Z). Real joint: about -70 to +80.
//   dev   + swings the hand edge-on within the plane of the palm; in bind that
//         drops the left fingertips toward -Y. Real joint: about -20 to +30.
//   twist   there is no wrist twist. Leave it 0. If a pose needs the palm
//         turned, roll the FOREARM — that is where pronation lives.
//
// PRONATION IS NOT WRITTEN AS AN ANGLE. Where the palm ends up pointing is the
// thing you actually care about, and it is not something you can work out in
// your head: the roll is composed underneath the elbow bend and the whole arm
// swing, so on `read` a hand-picked 62 came out as palms facing sideways. So a
// pose names the direction the palm should FACE, in character space, and the
// forearm roll that gets there is solved per frame:
//
//   LeftPalm: [0, 1, -0.4]     // palm up and a little toward the body
//
// See PALM AIMING below. A forearm still accepts a raw roll in a 4th slot for
// anything that wants to twist without caring where the palm lands, but if a
// palm target is present for that side the solved roll wins.
//
// Axes below are derived from the bind data and a PCA of every vertex weighted
// to the hand. Signed so that both palms face backward in the bind T-pose,
// which is what makes the mirror rule [f, -d, -t] come out exact.

/** Palm normal in hand-bone-local space. Exported so a viewer can draw it. */
export const PALM_NORMAL = {
  LeftHand:  new THREE.Vector3( 0.6311, -0.0609, -0.7733),
  RightHand: new THREE.Vector3(-0.6218, -0.0453, -0.7819),
}

/** Bone's rest orientation in character space. */
function bindWorld(bone) {
  const b = BIND[bone]
  return new THREE.Quaternion(b.pw[0], b.pw[1], b.pw[2], b.pw[3])
    .multiply(new THREE.Quaternion(b.q[0], b.q[1], b.q[2], b.q[3]))
}

const BONE_Y = new THREE.Vector3(0, 1, 0)

// The wrist frame, built off the FOREARM's long axis rather than the hand's.
// The two differ by 10 degrees, and it is the forearm that defines the joint:
// hang the frame off the hand instead and every flex leaks a little pronation.
//   twist = the forearm's long axis. There is no wrist twist; this exists only
//           so the mirror rule has something to negate.
//   dev   = the palm normal, squared up against the forearm axis.
//   flex  = the remaining axis, signed so + curls the hand palm-ward.
const WRIST = {}
const FOREARM_ROLL = {}
const FORE_AXIS = {}
const PALM_BIND = {}
for (const side of ['Left', 'Right']) {
  const hand = side + 'Hand', fore = side + 'ForeArm'
  const twist = BONE_Y.clone().applyQuaternion(bindWorld(fore)).normalize()
  const palm = PALM_NORMAL[hand].clone().applyQuaternion(bindWorld(hand)).normalize()
  const dev = palm.clone().addScaledVector(twist, -palm.dot(twist)).normalize()
  const flex = new THREE.Vector3().crossVectors(twist, dev).normalize()
  WRIST[hand] = { flex, dev, twist }
  FOREARM_ROLL[fore] = twist
  FORE_AXIS[side] = twist
  PALM_BIND[side] = palm
}

// ---------------------------------------------------------------------------
// Pose -> local quaternion
// ---------------------------------------------------------------------------
const _e = new THREE.Euler(0, 0, 0, 'XYZ')
const _d = new THREE.Quaternion()
const _x = new THREE.Quaternion()
const _pw = new THREE.Quaternion()
const _pwi = new THREE.Quaternion()
const _qb = new THREE.Quaternion()
const _out = new THREE.Quaternion()

/** A pose entry -> the bone's delta rotation, in whichever frame it authors in. */
function deltaQuat(bone, r, out) {
  const w = WRIST[bone]
  if (w) {
    // twist innermost, then dev, then flex: a wrist bends off a forearm that
    // has already been rolled, not the other way round.
    out.setFromAxisAngle(w.flex, (r[0] || 0) * D2R)
    if (r[1]) out.multiply(_x.setFromAxisAngle(w.dev, r[1] * D2R))
    if (r[2]) out.multiply(_x.setFromAxisAngle(w.twist, r[2] * D2R))
    return out
  }
  _e.set((r[0] || 0) * D2R, (r[1] || 0) * D2R, (r[2] || 0) * D2R, 'XYZ')
  out.setFromEuler(_e)
  const axis = FOREARM_ROLL[bone]
  if (axis && r[3]) out.multiply(_x.setFromAxisAngle(axis, r[3] * D2R))
  return out
}

// ---------------------------------------------------------------------------
// PALM AIMING
// ---------------------------------------------------------------------------
// Deltas chain in character space: world(bone) = d0*d1*...*dn * bind(bone). So
// the palm normal of a posed hand is
//
//   palm = M * R(roll) * d_hand * bindPalm       M = every delta down to the
//                                                    forearm's own swing
// R only spins the forearm about its own length, so as the roll sweeps, the
// palm traces a cone about the forearm axis (measured: a 100.5 degree cone that
// does not wobble). Aiming the palm is therefore a closed-form problem — find
// the point on that cone nearest the direction we want, and read off the angle.
// No search, no hand-tuned constants that stop being true the moment somebody
// nudges an elbow.
const ARM_CHAIN = {
  Left:  ['Hips', 'Spine02', 'Spine01', 'Spine', 'LeftShoulder', 'LeftArm'],
  Right: ['Hips', 'Spine02', 'Spine01', 'Spine', 'RightShoulder', 'RightArm'],
}

const ZERO3 = [0, 0, 0]
const _m = new THREE.Quaternion()
const _mi = new THREE.Quaternion()
const _tq = new THREE.Quaternion()
const _swing = [0, 0, 0]
const _vw = new THREE.Vector3()
const _vt = new THREE.Vector3()
const _e1 = new THREE.Vector3()
const _e2 = new THREE.Vector3()

/** Roll, in degrees, that points this side's palm as close to `aim` as the
 *  forearm can manage. `aim` is a direction in character space. */
function solveRoll(p, side, aim) {
  _m.identity()
  for (const b of ARM_CHAIN[side]) _m.multiply(deltaQuat(b, p[b] || ZERO3, _tq))
  // the forearm's swing, deliberately without its roll
  const fr = p[side + 'ForeArm'] || ZERO3
  _swing[0] = fr[0] || 0; _swing[1] = fr[1] || 0; _swing[2] = fr[2] || 0
  _m.multiply(deltaQuat(side + 'ForeArm', _swing, _tq))

  // where the palm sits at roll 0, wrist bend included
  _vw.copy(PALM_BIND[side]).applyQuaternion(deltaQuat(side + 'Hand', p[side + 'Hand'] || ZERO3, _tq))
  // pull the target back through the arm so the whole thing is a 2D problem
  _vt.set(aim[0], aim[1], aim[2]).normalize().applyQuaternion(_mi.copy(_m).invert())

  const a = FORE_AXIS[side]
  _e1.copy(_vw).addScaledVector(a, -_vw.dot(a))
  if (_e1.lengthSq() < 1e-8) return 0      // palm parallel to the forearm; no cone
  _e1.normalize()
  _e2.crossVectors(a, _e1)
  return Math.atan2(_e2.dot(_vt), _e1.dot(_vt)) / D2R
}

/** Replace any palm target with the forearm roll that achieves it. Returns a
 *  pose safe to hand to localQuat; never mutates the input. */
function resolvePose(p) {
  let out = p
  for (const side of ['Left', 'Right']) {
    const aim = p[side + 'Palm']
    if (!aim) continue
    if (out === p) out = Object.assign({}, p)
    const fr = p[side + 'ForeArm'] || ZERO3
    out[side + 'ForeArm'] = [fr[0] || 0, fr[1] || 0, fr[2] || 0, solveRoll(p, side, aim)]
  }
  return out
}

// world_final = delta * world_bind, expressed back in the bone's local space:
//   local_final = inv(pw) * delta * pw * q_bind
function localQuat(bone, r, out = _out) {
  const b = BIND[bone]
  deltaQuat(bone, r, _d)
  _pw.set(b.pw[0], b.pw[1], b.pw[2], b.pw[3])
  _pwi.copy(_pw).invert()
  _qb.set(b.q[0], b.q[1], b.q[2], b.q[3])
  return out.copy(_pwi).multiply(_d).multiply(_pw).multiply(_qb)
}

/** Snap a character to a static pose. Handy for debugging and for parking a
 *  character in a held state without running a mixer. */
export function applyPose(root, rawPose) {
  const pose = resolvePose(rawPose)
  for (const name of BONES) {
    const r = pose[name]
    if (!r) continue
    const bone = root.getObjectByName(name)
    if (!bone) continue
    localQuat(name, r, bone.quaternion)
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

/** Mirror a pose across the character's YZ plane.
 *  Negate components 1 and 2 and swap the names. The wrist frame was signed so
 *  that the same rule mirrors [flex, dev, twist] correctly, and a forearm roll
 *  in slot 3 mirrors the same way. Palm targets are directions, not rotations,
 *  so they mirror the other way round: negate X, keep Y and Z. */
export function mirrorPose(p) {
  const o = {}
  for (const k in p) {
    if (k === 'hips') { o.hips = [-p.hips[0], p.hips[1], p.hips[2]]; continue }
    const swapped = k.startsWith('Left') ? 'Right' + k.slice(4)
                  : k.startsWith('Right') ? 'Left' + k.slice(5) : k
    const v = p[k]
    if (k.endsWith('Palm')) { o[swapped] = [-v[0], v[1], v[2]]; continue }
    o[swapped] = v.length > 3 ? [v[0], -v[1], -v[2], -v[3]] : [v[0], -v[1], -v[2]]
  }
  return o
}

/** Blend two pose entries. Handles the forearm's optional 4th channel. */
function mixRot(a, b, k) {
  const n = Math.max(a.length, b.length)
  const o = new Array(n)
  for (let i = 0; i < n; i++) o[i] = mix(a[i] || 0, b[i] || 0, k)
  return o
}

// ---------------------------------------------------------------------------
// Base poses
// ---------------------------------------------------------------------------

// Palm directions, in character space (+X left, +Y up, +Z forward). These are
// targets, not angles — the forearm roll that hits them is solved per frame.
const PALM_IN_L    = [-1, -0.05, -0.32]   // hanging arm, palm to the thigh
const PALM_DOWN    = [0, -1, -0.12]       // over a desk or a keyboard
const PALM_UP_L    = [0.22, 0.92, -0.36]  // under a book, thumb toward the face
const PALM_FWD     = [-0.06, 0.16, 0.99]  // out at whoever is being greeted
const PALM_SIP_R   = [0.80, 0.10, -0.60]  // holding a mug at the mouth

// Arms down at the sides. This is the fix for the T-pose. ~100 deg of Z drops
// the arm from horizontal to hanging with a little clearance from the hip.
// ELBOW: in bind the forearm points sideways along X, so flexion (hand moves
// forward) is a rotation about -Y on the left and +Y on the right.
const ARMS_DOWN = {
  LeftShoulder: [0, 0, -2],   RightShoulder: [0, 0, 2],
  LeftArm:      [-4, -8, -99], RightArm:     [-4, 8, 99],
  LeftForeArm:  [0, -16, 0], RightForeArm: [0, 16, 0],
  LeftHand:     [5, -4, 0],   RightHand:    [5, 4, 0],
  LeftPalm: PALM_IN_L, RightPalm: [1, -0.05, -0.32],
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
  // hands come off the thighs and forward, so the palms turn down
  LeftForeArm: [0, -52, 0], RightForeArm: [0, 52, 0],
  LeftHand:    [7, -4, 0],  RightHand:    [7, 4, 0],
  LeftPalm: PALM_DOWN, RightPalm: PALM_DOWN,
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
//
// `sp` is a per-character SEED_PARAMS bundle (see setSeed near the bottom):
// idleAmp scales the whole motion, idleHarmonics wobble the timing a little.
// Both default to the identity bundle, so an unseeded call reproduces the
// exact numbers this clip always had.
function idlePose(t, sp = SEED_IDENTITY) {
  const tn = t + idleNoise(t, sp)   // seed's slow timing wobble; still periodic in t
  const s = sin(tn) * sp.idleAmp   // weight shift
  const br = sin(tn, 2) * sp.idleAmp  // breath
  const sway = 2.2 * s
  return pose(STAND, {
    hips:    [1.5 * s, -0.35 + 0.35 * cos(tn, 2) * 0.5, 0],
    Hips:    [0, 1.2 * s, sway],
    Spine02: [0.6 * br, -0.7 * s, -0.9 * s],
    Spine01: [-0.5 * br, -0.5 * s, -0.6 * s],
    Spine:   [-1.4 * br, -0.4 * s, -0.5 * s],   // chest lifts on the inhale
    neck:    [0.6 * br, 0.5 * s, 0],
    Head:    [-0.8 + 1.0 * sin(tn + 0.15), 1.8 * sin(tn + 0.1), -0.8 * s],
    LeftArm:  [-4 + 1.6 * s, -8, -99 + 1.4 * s],
    RightArm: [-4 + 1.6 * s, 8, 99 + 1.4 * s],
    LeftForeArm:  [0, -16 - 2 * br, 0],
    RightForeArm: [0, 16 + 2 * br, 0],
    // hands hang off the wrist and lag the breath a touch. Palms stay on the
    // thighs; STAND's targets already say so, and the roll re-solves as the
    // elbow breathes, which is what keeps them from drifting outward.
    LeftHand:  [5 + 1.6 * br, -4, 0],
    RightHand: [5 + 1.6 * br, 4, 0],
  })
}

// --- walk ------------------------------------------------------------------
// One clip cycle = two steps. Leg phase p: 0 is heel strike, 0.5 is toe-off
// and the other foot's heel strike.

// Knee: nearly straight through stance with a small loading dip just after
// contact, then a big flexion in swing to get the foot off the floor.
function kneeCurve(p) {
  return 3
    + 11 * bump(p, 0.14, 0.26)
    + 57 * bump(p, 0.72, 0.34)
}

// Thigh sweep at heel strike / toe-off, degrees. Same amplitude the old
// single-cosine curve used, kept as the stance/swing boundary values so
// stride length and timing don't change, only the shape between them.
const THIGH_AMPLITUDE = 24

// -----------------------------------------------------------------------
// Stance foot solve
// -----------------------------------------------------------------------
// A thigh curve that is a single cosine over the whole gait cycle keeps the
// phasing right but makes the ANKLE's fore-aft travel sinusoidal: constant
// angular velocity at the hip does not mean constant ground velocity at the
// far end of a two-link leg. Invisible during swing. During STANCE it is a
// bug — the foot is on the floor, so the body should pass over it at a
// constant rate (the walk speed), which means the ankle's position relative
// to the hip has to be LINEAR in phase, not sinusoidal. A sinusoidal stance
// curve makes the "planted" foot slide back and forth under the body as the
// thigh sweeps through it.
//
// Fix: solve the thigh angle per stance sample so ankle-relative-to-hip Z is
// linear. This goes through the same pose math as everywhere else
// (localQuat/applyPose, against a tiny scratch rig) rather than a
// hand-derived trig formula for the leg, so it can't drift out of sync with
// how the rig actually composes rotations.
const _legRig = (() => {
  const parent = { Hips: null, LeftUpLeg: 'Hips', LeftLeg: 'LeftUpLeg', LeftFoot: 'LeftLeg' }
  const bones = {}
  for (const name in parent) {
    const b = new THREE.Object3D()
    b.name = name   // applyPose finds bones with getObjectByName
    const bd = BIND[name]
    b.position.set(bd.t[0], bd.t[1], bd.t[2])
    b.quaternion.set(bd.q[0], bd.q[1], bd.q[2], bd.q[3])
    bones[name] = b
  }
  for (const name in parent) { const p = parent[name]; if (p) bones[p].add(bones[name]) }
  bones.Hips.updateMatrixWorld(true)
  return bones
})()
const _legHipZ = _legRig.LeftUpLeg.getWorldPosition(new THREE.Vector3()).z
const _legAnkleV = new THREE.Vector3()

/** Ankle's fore-aft (Z) position relative to the hip, cm, for a given thigh
 *  (X delta, degrees) and knee flexion. Solved off the LEFT leg chain;
 *  legPose() shares the result across both legs, same as it already shares
 *  its curve. */
function ankleZ(thigh, knee) {
  applyPose(_legRig.Hips, { LeftUpLeg: [thigh, 2, 3], LeftLeg: [knee, 0, 0] })
  _legRig.LeftFoot.getWorldPosition(_legAnkleV)
  return _legAnkleV.z - _legHipZ
}

// Endpoints of the stance sweep. kneeCurve is 3 (baseline) at both p=0 and
// p=0.5 — the loading dip lands strictly inside stance — so these use the
// baseline knee angle and match the old curve's -24/+24 exactly.
const STANCE_Z0   = ankleZ(-THIGH_AMPLITUDE, 3)   // heel strike, foot forward
const STANCE_Z1   = ankleZ(THIGH_AMPLITUDE, 3)    // toe-off, foot back

/** Thigh angle (degrees) whose ankleZ(thigh, knee) hits `targetZ`. ankleZ is
 *  monotonically decreasing in thigh over the walk's range, so bisection
 *  always converges; run enough steps that the result is float-exact at the
 *  endpoints (needed for the loop seam). */
function solveThighForZ(targetZ, knee) {
  let lo = -THIGH_AMPLITUDE - 1, hi = THIGH_AMPLITUDE + 1
  for (let i = 0; i < 40; i++) {
    const mid = (lo + hi) / 2
    if (ankleZ(mid, knee) > targetZ) lo = mid; else hi = mid
  }
  return (lo + hi) / 2
}

function legPose(p) {
  const knee = kneeCurve(p)

  // Thigh: linear ankle travel through stance, the old single-cosine sweep
  // through swing (where a natural-looking accel/decel is fine — nothing is
  // planted). wrap() first so p=0 and p=1 land on the same branch; otherwise
  // the loop seam breaks even though the underlying trig is periodic.
  const pw = wrap(p)
  const thigh = pw <= 0.5
    ? solveThighForZ(STANCE_Z0 + (STANCE_Z1 - STANCE_Z0) * (pw / 0.5), knee)
    : -THIGH_AMPLITUDE * cos(pw)

  // Ankle: slight toes-up at heel strike, roll flat, plantarflex hard at
  // toe-off, dorsiflex again in swing for clearance. +X is toes down.
  const foot = -7 * bump(p, 0.0, 0.26)
    + 21 * bump(p, 0.47, 0.24)
    - 9 * bump(p, 0.74, 0.38)

  // Toes hinge up as the heel leaves the floor. -X is toes up.
  const toe = -32 * bump(p, 0.52, 0.22) + 6 * bump(p, 0.05, 0.18)

  return { thigh, knee, foot, toe }
}

function walkPose(t, sp = SEED_IDENTITY) {
  // Stance/swing leg curves are seed-independent on purpose: they're what the
  // no-slip stance solve is built on (see STANCE_Z0/STANCE_Z1 above), and
  // WALK_CYCLE_METERS has to stay honest for every character.
  const L = legPose(t)             // left leg strikes at t=0
  const R = legPose(t + 0.5)       // right leg is half a cycle behind

  // Contralateral: the left arm swings back while the left leg swings forward.
  // sp gives each side its own amplitude and a small phase offset, so two
  // characters walking side by side don't swing their arms in lockstep.
  const armL = 19 * sp.walkAmpL * cos(t + sp.walkPhaseL)
  const armR = -19 * sp.walkAmpR * cos(t + sp.walkPhaseR)
  const elbowL = 18 + 9 * bump(t, 0.5, 0.5)
  const elbowR = 18 + 9 * bump(t, 0.0, 0.5)
  const bob = sp.walkBob

  return pose(STAND, {
    // Two bobs per cycle, lowest at each double-support, plus weight shifting
    // laterally over whichever foot is planted.
    hips: [1.7 * sin(t), -1.5 * bob * cos(t, 2), 0],
    Hips: [1.5, -4.5 * bob * cos(t), 3.0 * bob * cos(t)],

    // Torso counter-rotates against the pelvis, which is what stops a walk
    // from looking like a wind-up toy.
    Spine02: [1.5, 2.2 * bob * cos(t), -1.2 * bob * cos(t)],
    Spine01: [1.0, 2.6 * bob * cos(t), -0.8 * bob * cos(t)],
    Spine:   [0.5, 3.0 * bob * cos(t), -0.6 * bob * cos(t)],
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
    // the hand trails the swing: extends as the arm goes back, flexes forward
    LeftHand:  [7 - 5 * cos(t), -5, 0],
    RightHand: [7 + 5 * cos(t), 5, 0],
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
  for (const bone of BONES) out[bone] = mixRot(STAND[bone], SEATED[bone], k)
  // palms roll off the thighs and turn down as the hands come forward
  out.LeftPalm = mixRot(STAND.LeftPalm, SEATED.LeftPalm, k)
  out.RightPalm = mixRot(STAND.RightPalm, SEATED.RightPalm, k)
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
    // palms flat over the keys; the wrist only taps
    LeftForeArm:  [0, -74 + 2 * a, 0], RightForeArm: [0, 74 - 2 * b, 0],
    LeftHand:  [13 + 6 * a, -3, 0],
    RightHand: [13 + 6 * b, 3, 0],
    LeftPalm:  [0.10, -1, 0.06], RightPalm: [-0.10, -1, 0.06],
  })
}

// --- highfive --------------------------------------------------------------
// One shot, authored for ONE spacing. This clip does not try to reach whatever
// distance the partner happens to be at — the controller walks both characters
// onto marks first (see highfive.js) and then this plays. That is how a
// choreographed contact has always been done: hit your mark, play the canned
// action. It costs nothing per frame and it is right every time.
//
// The contract with highfive.js is one number. At t = HIGHFIVE_CONTACT_T the
// palm centre sits at
//
//     x = 0                       on the character's OWN midline
//     y = HIGHFIVE_CONTACT_Y_CM   about eye height
//     z = HIGHFIVE_CONTACT_Z_CM   forward reach
//
// with the palm square on to +Z. Two characters facing each other 2z apart put
// their palm centres at the same world point, whatever their world positions
// and headings, because a 180 degree turn maps (0, y, z) onto (-0, y, -z).
// x = 0 is the load-bearing part: reaching only as far as the shoulder line
// would leave the two hands a shoulder-width apart on opposite sides.
//
// Both characters play THIS clip, not a mirrored copy. Facing each other is
// already the mirror: each raises its right hand, and those end up on opposite
// sides in world space, so each reaches across its own centreline and they meet
// in the middle. Running the mirrored clip on the partner would pair a right
// hand with a left one and the contact slides off to one side.
//
// The pose at contact was solved rather than eyeballed: 11 angles fitted so the
// palm lands on that point with the palm normal forward, inside joint limits,
// with the elbow left bent. Nudging any of them by hand moves the contact, so
// nudge HF_CONTACT and re-fit rather than editing it in place — and if the
// contact z moves, CONTACT_Z_CM in highfive.js moves with it.

/** Fraction of the clip at which the palms touch. Must be a sampled key. */
export const HIGHFIVE_CONTACT_T = 0.5
/** Palm centre at contact, in the GLB's armature centimetres. */
export const HIGHFIVE_CONTACT_Y_CM = 149.0
export const HIGHFIVE_CONTACT_Z_CM = 45.93

// [hipsYaw, lean, twist, shoulderYaw, shoulderZ, armX, armY, armZ, elbow, wristFlex, wristDev]
// hipsYaw stays small on purpose: the legs hang off the hips, so yawing them
// pivots the feet. The reach across comes from the spine, spread over three
// bones, which is what a person actually does.
const HF_REST    = [0,    0,  0,  0,   2,   -4,  8, 99, 16,   5,  4]
const HF_WINDUP  = [1,    0,  6,  4, -18,   10, 44, 30, 88,  -6, 12]
// Cocked and ready, one tenth of the clip before contact. Without this key the
// windup-to-contact lerp bulges the palm 4cm PAST the contact plane on its way
// there, which puts the two hands through each other a frame before they touch.
// With it the palm closes on the plane from behind and from its own side.
const HF_SWING   = [3,    11, 14,  6,  -2,  -42, 54, 30, 98,  -2, 20]
const HF_CONTACT = [4.02, 18, 32.01, 8.01, -10.16, -31.35, 60.25, -6.12, 29.99, -28.18, 22.01]
const HF_RECOIL  = [3,    11, 26,  8,  -4,  -24, 58, -6, 58, -20, 20]
// Same trap as HF_SWING, mirrored: recoil straight to the drop and the lerp
// swings the palm 3cm through the contact plane on the way down, i.e. into
// where the partner's hand still is. This holds the retreat behind the plane.
const HF_FALL    = [0,     4,  6, -21,  4,  -43, 70, 105, 100, -34, 22]
// The way back down needs its own key. Lerping straight from the recoil to the
// rest pose takes armZ from -6 to 99 and the elbow from 58 to 16 at the same
// time, which swings the hand OUT past where it just made contact before it
// falls. This routes it down the front of the body instead.
const HF_DROP    = [1,     4, 10,  2,   0,   10, 30, 62, 42,   2,  8]

const HF_PALM_REST    = [1, -0.05, -0.32]   // hanging, on the thigh
const HF_PALM_WINDUP  = [0.50, 0.45, 0.74]  // rolling over as it comes up
const HF_PALM_SWING   = [-0.10, 0.16, 0.98] // already square before the strike
const HF_PALM_CONTACT = [0, 0.14, 0.99]     // square on to the partner
const HF_PALM_RECOIL  = [0.10, 0.22, 0.97]
const HF_PALM_FALL    = [0.45, 0.15, 0.88]  // turning over as the arm comes down
const HF_PALM_DROP    = [0.85, 0.05, 0.05]

// How committed the pose is, per key. Drives everything secondary — the head,
// the off arm — so those never need their own timing curve.
const HF_K = { rest: 0, windup: 0.55, swing: 0.85, contact: 1, recoil: 0.85, fall: 0.6, drop: 0.4 }

const lerpArr = (a, b, u) => a.map((v, i) => v + (b[i] - v) * u)

const smooth = u => u * u * (3 - 2 * u)

// Segment table: [end t, from, to, fromPalm, toPalm, kFrom, kTo, easing]. Every
// boundary is a sampled key of the clip (21 keys => steps of 0.05), so the pose
// function is only ever evaluated at a segment end or inside one, never across.
const HF_SEGS = [
  [0.30, HF_REST,    HF_WINDUP,  HF_PALM_REST,    HF_PALM_WINDUP,  HF_K.rest,    HF_K.windup,  smooth],
  [0.40, HF_WINDUP,  HF_SWING,   HF_PALM_WINDUP,  HF_PALM_SWING,   HF_K.windup,  HF_K.swing,   smooth],
  // the strike: accelerates in, so the last frames before contact are the fast ones
  [0.50, HF_SWING,   HF_CONTACT, HF_PALM_SWING,   HF_PALM_CONTACT, HF_K.swing,   HF_K.contact, u => Math.pow(u, 1.6)],
  // and bounces straight off it
  [0.60, HF_CONTACT, HF_RECOIL,  HF_PALM_CONTACT, HF_PALM_RECOIL,  HF_K.contact, HF_K.recoil,  u => 1 - (1 - u) * (1 - u)],
  [0.70, HF_RECOIL,  HF_FALL,    HF_PALM_RECOIL,  HF_PALM_FALL,    HF_K.recoil,  HF_K.fall,    smooth],
  [0.80, HF_FALL,    HF_DROP,    HF_PALM_FALL,    HF_PALM_DROP,    HF_K.fall,    HF_K.drop,    smooth],
  [1.00, HF_DROP,    HF_REST,    HF_PALM_DROP,    HF_PALM_REST,    HF_K.drop,    HF_K.rest,    smooth],
]

/** Blend through rest -> windup -> swing -> contact -> recoil -> drop -> rest.
 *  t = HIGHFIVE_CONTACT_T returns HF_CONTACT exactly, which is the whole point. */
function hfBlend(t) {
  let i = 0, t0 = 0
  while (i < HF_SEGS.length - 1 && t >= HF_SEGS[i][0]) { t0 = HF_SEGS[i][0]; i++ }
  const [t1, a, b, pa, pb, ka, kb, easing] = HF_SEGS[i]
  const u = easing(Math.min(1, Math.max(0, (t - t0) / (t1 - t0))))
  return { v: lerpArr(a, b, u), palm: lerpArr(pa, pb, u), k: ka + (kb - ka) * u }
}

function highfivePose(t) {
  const { v, palm, k } = hfBlend(t)
  const [hipsYaw, lean, twist, shY, shZ, armX, armY, armZ, elbow, flex, dev] = v

  return pose(STAND, {
    // No hips translation anywhere in this clip. The feet are children of the
    // hips, so sliding the pelvis forward for a lean drags them along the
    // floor. Every bit of the reach is rotation.
    hips: [0, 0, 0],
    Hips:    [0, hipsYaw, 0],
    Spine02: [lean * 0.45, twist * 0.34, 0],
    Spine01: [lean * 0.30, twist * 0.33, 0],
    Spine:   [lean * 0.25, twist * 0.33, 0],
    // the torso turns under the head; the neck gives most of it back so the
    // character keeps looking at the partner rather than past their shoulder
    neck:    [0, -10 * k, 0],
    Head:    [-6 * k, -17 * k, 2 * k],

    RightShoulder: [0, shY, shZ],
    RightArm:      [armX, armY, armZ],
    RightForeArm:  [0, elbow, 0],
    RightHand:     [flex, dev, 0],
    RightPalm:     palm,

    // Off arm counterbalances. Mostly elbow: swinging the whole arm back leaves
    // the hand splayed out behind the hip where it catches the eye.
    LeftArm:      [-4 - 7 * k, -8, -99 + 3 * k],
    LeftForeArm:  [0, -16 - 32 * k, 0],
    LeftHand:     [5 + 4 * k, -4, 0],
  })
}

// --- drink -----------------------------------------------------------------
// Hand to mouth and back, holding a cup. Loops, with a long low dwell so it
// does not look frantic if left running.
// The face has no mouth mesh to aim at, so "mouth" is a fixed point measured
// off the Head bone, the same way palmPoint() in highfive.js measures a palm
// off the hand bone. Offset is expressed along NECK's world axes rather than
// Head's: neck's own bind rotation is ~1.4 degrees, close enough to identity
// that "down"/"forward" read as the character's own down/forward, and using
// neck rather than Head means the nod below (a Head-local rotation) does not
// drag the target around with it — the mouth stays put while the head tips.
//
// The two numbers were found by sweeping markers in the office/anim-test
// scene until one sat where a mouth belongs on this face (under the nose,
// above the chin): 2cm UP and 11cm forward of the Head bone. "Up" because
// this rig's Head joint sits close to jaw height already, not centre-of-skull
// — the giant crown is ~45cm above it (see head_end, elsewhere).
const MOUTH_UP_CM = 2
const MOUTH_FWD_CM = 11
const MOUTH_DOWN_LOCAL = new THREE.Vector3(-0.001423, -0.999692, 0.024796)
const MOUTH_FWD_LOCAL = new THREE.Vector3(0.00146, 0.024794, 0.999692)

function drinkPose(t) {
  const raise = bump(t, 0.5, 0.9)             // up and back down
  const sip = bump(t, 0.5, 0.28)              // head nod at the top
  const k = raise
  return pose(STAND, {
    Hips: [0, -3 * k, 0],
    Spine02: [1 * k, -3 * k, 0], Spine01: [0, -3 * k, 0], Spine: [-1 * k, -3 * k, 0],
    // a small forward-and-down nod as the cup arrives, easing back after.
    // Head X positive tips the TOP of the head forward, which is what reads
    // as looking down — this is Head, not a spine bone, so the chain's
    // inversion (Spine02 is the belly) doesn't come into it here.
    neck: [3 * sip, 0, 0],
    Head: [9 * sip, -5 * k, 0],
    // Solved, not eyeballed: fit so the palm centre (palmPoint in
    // highfive.js) lands on the mouth point above at k=1, with the palm
    // aimed in at the face throughout via RightPalm. The old arm swung out
    // and left the hand 20cm short at the wrist, 8cm at the palm centre.
    RightShoulder: [0, 0, mix(2, -16.3, k)],
    RightArm:     [mix(-4, -36.9, k), mix(8, 71, k), mix(99, 77.7, k)],
    RightForeArm: [0, mix(16, 137.4, k), 0],
    RightHand:    [mix(5, 13.7, k), mix(4, -6.3, k), 0],
    RightPalm:    [mix(1, PALM_SIP_R[0], k), mix(-0.05, PALM_SIP_R[1], k), mix(-0.32, PALM_SIP_R[2], k)],
    LeftArm:      [-4, -8, -99],
    LeftForeArm:  [0, -16 - 4 * k, 0],
    LeftHand:     [5, -4, 0],
  })
}

/** Where the mouth is in world space, for a character posed by `root` and
 *  placed at `height` metres. Same shape as highfive.js's palmPoint(): a
 *  fixed local offset off a bone, not a literal mesh feature (this face has
 *  no mouth to find). 170.0 is highfive.js's MODEL_HEIGHT_CM, duplicated
 *  rather than imported to avoid a cycle (highfive.js imports this module). */
export function mouthPoint(root, height = 1.68) {
  const head = root.getObjectByName('Head')
  const neck = root.getObjectByName('neck')
  if (!head || !neck) return null
  const k = height / 170.0
  const q = new THREE.Quaternion()
  neck.matrixWorld.decompose(new THREE.Vector3(), q, new THREE.Vector3())
  const out = head.getWorldPosition(new THREE.Vector3())
  out.addScaledVector(MOUTH_DOWN_LOCAL.clone().applyQuaternion(q), -MOUTH_UP_CM * k)
  out.addScaledVector(MOUTH_FWD_LOCAL.clone().applyQuaternion(q), MOUTH_FWD_CM * k)
  return out
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
    // both palms come up under whatever is being read. Aimed rather than
    // rolled: an 86 degree elbow swings a hand-picked roll most of the way
    // round, which is how these two ended up facing out sideways.
    LeftForeArm:  [0, -86, 0],
    RightForeArm: [0, 86 - 26 * turn, 0],
    LeftPalm:  PALM_UP_L,
    RightPalm: [-PALM_UP_L[0], PALM_UP_L[1], PALM_UP_L[2]],
    // the page turn is a flick of the wrist — flexion, not a sideways sweep.
    LeftHand:  [-7, -5, 0],
    RightHand: [-7 + 34 * turn, 5 - 9 * turn, 0],
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
    // The thighs hang off Hips, so pitching the pelvis from SEATED's -12 to +6
    // to get the slump swings both legs down with it and drives the feet
    // through the floor. Give the 18 back at the hip joint so the legs stay
    // where SEATED put them and only the spine slumps.
    LeftUpLeg: [-88, 5, 4], RightUpLeg: [-88, -5, -4],
    Spine02: [26 + 0.9 * breath, 0, 2],
    Spine01: [16 + 0.7 * breath, 0, 1],
    Spine:   [12 + 0.5 * breath, 2, 1],
    neck:    [16, 0, 0],
    Head:    [20, 6, 3],
    LeftShoulder: [0, 0, 6], RightShoulder: [0, 0, -6],
    LeftArm:  [-46, -22, -66], RightArm: [-46, 22, 66],
    LeftForeArm:  [0, -96, 0], RightForeArm: [0, 96, 0],
    LeftHand:  [9, -6, 0], RightHand: [9, 6, 0],
    // folded on the desk, palms flat to it
    LeftPalm:  [0.18, -0.97, -0.16], RightPalm: [-0.18, -0.97, -0.16],
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
    // elbow out at shoulder height with the forearm near vertical. The old arm
    // left the forearm pointing forward, which put palm-forward 45 degrees
    // inside the reachable cone — no roll could have got there.
    RightArm:     [-70, -10, 45],
    // palm aimed at whoever is being waved at and held there while the elbow
    // moves; the wave itself is the hand rocking edge to edge, which is
    // deviation about the palm normal and so does not disturb the aim.
    RightForeArm: [0, 100 + 5 * osc, 0],
    RightHand:    [-6, 17 * osc, 0],
    RightPalm:    PALM_FWD,
    LeftArm:      [-4 + 1.5 * weight, -8, -99],
    LeftForeArm:  [0, -18, 0],
    LeftHand:     [5, -4, 0],
  })
}

// ---------------------------------------------------------------------------
// Per-character seed
// ---------------------------------------------------------------------------
// LINEAR is the only interpolation QuaternionKeyframeTrack actually has in
// r170 (setInterpolation(InterpolateSmooth) is a silent no-op on quaternion
// tracks), so "smooth" for a sparse clip means more keys, not a fancier
// curve — see the key counts below. Deterministic per-character variance is
// the other half of not looking mechanical: two characters idling side by
// side with the exact same amplitude and timing read as one puppet wearing
// two skins.
//
// seed 0 is the identity — every multiplier 1, every offset 0, no harmonics —
// so an unseeded call bakes exactly the numbers this file always had.
const SEED_IDENTITY = {
  walkAmpL: 1, walkAmpR: 1, walkPhaseL: 0, walkPhaseR: 0, walkBob: 1,
  idleAmp: 1, idleHarmonics: [],
}

/** Deterministic PRNG (mulberry32) so a given seed always bakes the same
 *  clips — no Math.random, or "cache clips per seed" would just cache noise. */
function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const _seedParamsCache = new Map()

/** Per-character variance bundle for a seed. A few percent of L/R asymmetry
 *  on the walk's arm swing (amplitude and phase) and on idle's amplitude,
 *  plus a couple of slow harmonics that wobble idle's timing. Deliberately
 *  does not touch legPose/kneeCurve/ankleZ: the no-slip stance solve and
 *  WALK_CYCLE_METERS have to stay true for every seed. */
function seedParams(seed) {
  if (!seed) return SEED_IDENTITY
  let sp = _seedParamsCache.get(seed)
  if (sp) return sp
  const rnd = mulberry32(seed * 0x9e3779b1)
  const jitter = amp => 1 + (rnd() * 2 - 1) * amp
  const small = amp => (rnd() * 2 - 1) * amp
  sp = {
    walkAmpL: jitter(0.04), walkAmpR: jitter(0.04),
    walkPhaseL: small(0.015), walkPhaseR: small(0.015),
    walkBob: jitter(0.03),
    idleAmp: jitter(0.05),
    // low integer k's keep sin(TAU*(k*t+phase)) periodic over t in [0,1], so
    // this stays a seamless loop no matter the phase — see idleNoise below.
    idleHarmonics: [
      { amp: 0.010 + rnd() * 0.010, k: 3, phase: rnd() },
      { amp: 0.006 + rnd() * 0.008, k: 5, phase: rnd() },
    ],
  }
  _seedParamsCache.set(seed, sp)
  return sp
}

/** Slow, low-amplitude wobble added to idle's own clock. Sum of a couple of
 *  fixed-integer-frequency sines: periodic in t by construction (see the
 *  comment on idleHarmonics), so it can be baked into a looping clip without
 *  putting a seam at t=0/1. */
function idleNoise(t, sp) {
  let n = 0
  for (const h of sp.idleHarmonics) n += h.amp * Math.sin(TAU * (h.k * t + h.phase))
  return n
}

// ---------------------------------------------------------------------------
// Clip table
// ---------------------------------------------------------------------------
// Exported so a paired-action module can fold its own clips in — see
// clips/argue.js's header ("an integrator can fold straight into anim.js's
// own CLIPS table"). Merge before the first createClips() call: the table is
// cached on first use, so a merge after some other clip has already played
// is silently too late.
//
// A spec is { fn, dur, keys, loop } plus one optional flag:
//   fn(t01, seed)  t01 in [0,1]; `seed` is the seedParams() bundle for the
//                  character being baked. Ignore it and the clip comes out
//                  identical for every character — which is what all but
//                  idle/walk want, and what makes `seeded` below meaningful.
//   seeded         fn reads the seed bundle, so this clip is baked per
//                  character rather than shared (see createClips).
export const CLIPS = {
  // idle and walk are the only two pose functions that read the seed bundle,
  // so they are the only two baked per character — see createClips.
  idle:     { fn: idlePose,     dur: 4.6,  keys: 48, loop: true, seeded: true },
  walk:     { fn: walkPose,     dur: 1.05, keys: 18, loop: true, seeded: true },
  sit:      { fn: sitPose,      dur: 1.5,  keys: 14, loop: false },
  type:     { fn: typePose,     dur: 2.0,  keys: 20, loop: true },
  // 21 keys puts a sample exactly on 0.30, 0.50 and 0.60, which is where the
  // pose function changes segment. The contact frame has to BE a key: slerped
  // between neighbours it lands a centimetre or two short. Not raised with
  // the other sparse clips below — the contact math is fitted to this exact
  // key layout (see HF_CONTACT above).
  highfive: { fn: highfivePose, dur: 1.5,  keys: 21, loop: false },
  drink:    { fn: drinkPose,    dur: 3.4,  keys: 48, loop: true },
  read:     { fn: readPose,     dur: 5.0,  keys: 48, loop: true },
  sleep:    { fn: sleepPose,    dur: 5.5,  keys: 48, loop: true },
  wave:     { fn: wavePose,     dur: 2.2,  keys: 18, loop: true },
}

export const CLIP_NAMES = Object.keys(CLIPS)
export const ONE_SHOT = new Set(['sit', 'highfive'])
/** Clips that leave the character seated. Useful for deciding what to play next. */
export const SEATED_CLIPS = new Set(['sit', 'type', 'sleep'])

function buildClip(name, spec, { mirror = false, seed = 0 } = {}) {
  const { fn, dur, keys, loop } = spec
  const sp = seedParams(seed)
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
    let p = fn(t01, sp)
    if (mirror) p = mirrorPose(p)
    p = resolvePose(p)
    for (const b of BONES) {
      const r = p[b] || [0, 0, 0]
      localQuat(b, r, q)
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
  // `bake` keeps the raw per-bone quaternion arrays around (LINEAR, same as
  // the track above) so crossfade() can sample an exact pose at an arbitrary
  // phase — for phase matching and inertialization — without going through
  // an AnimationMixer to do it.
  clip.userData = { loop, oneShot: !loop, bake: { rot, n } }
  return clip
}

const _clipCacheBySeed = new Map()
/** Build (and memoise) every clip for one character seed. Returns
 *  { name: AnimationClip }.
 *
 *  Only the clips whose spec says `seeded` are baked per seed — everything
 *  else ignores the seed bundle and bakes byte-identical keyframes for every
 *  character, so they are built once for seed 0 and shared. Baking all of
 *  them per seed cost ~400KB and ~10ms of keyframe work per new agent id,
 *  none of it different from seed 0's copy. */
export function createClips(seed = 0) {
  seed = seed >>> 0
  let cache = _clipCacheBySeed.get(seed)
  if (cache) return cache
  const shared = seed === 0 ? null : createClips(0)
  cache = {}
  for (const name in CLIPS) {
    cache[name] = shared && !CLIPS[name].seeded ? shared[name] : buildClip(name, CLIPS[name], { seed })
  }
  // Left-handed high five. NOT what a pair should play — two characters facing
  // each other are already mirrored by the facing, so both play `highfive` and
  // right meets right. This is here for a character that wants to five with the
  // other hand (someone approaching from the wrong side, say); it will not make
  // contact against `highfive`.
  cache.highfiveMirror = shared && !CLIPS.highfive.seeded
    ? shared.highfiveMirror
    : buildClip('highfive', CLIPS.highfive, { mirror: true, seed })
  _clipCacheBySeed.set(seed, cache)
  return cache
}

export function getClip(name, seed = 0) {
  const c = createClips(seed)[name]
  if (!c) throw new Error(`anim: no clip "${name}". Have: ${Object.keys(createClips(seed)).join(', ')}`)
  return c
}

// ---------------------------------------------------------------------------
// Playback helpers
// ---------------------------------------------------------------------------
const RIGS = new WeakMap()

/** Mixer for a character, created on first use and cached on the object. */
export function getMixer(obj) {
  let r = RIGS.get(obj)
  if (!r) {
    r = {
      mixer: new THREE.AnimationMixer(obj), current: null, actions: new Map(), seed: 0,
      fade: null,      // in-flight crossfade: { prev, next, dur, t }
      inertia: null,   // in-flight pose correction: { offsets: Map(bone->Quaternion), dur, t }
      bones: null,     // Map(name -> Object3D), filled in lazily
      prevQuats: null, // for popMetric: Map(bone -> last frame's quaternion)
      maxAngVel: 0,
    }
    RIGS.set(obj, r)
  }
  return r.mixer
}

function rigOf(obj) { getMixer(obj); return RIGS.get(obj) }

/** Bone name -> Object3D, built once per character and reused — bones don't
 *  change identity after the rig is built, and this is looked up every
 *  frame by update()'s inertia and velocity passes. */
function boneMap(obj, rig) {
  if (!rig.bones) {
    rig.bones = {}
    for (const n of BONES) rig.bones[n] = obj.getObjectByName(n)
  }
  return rig.bones
}

/** Give this character its own baked clip set: a seed of 0 (the default) is
 *  the original unvaried motion; any other integer seed bakes a few percent
 *  of L/R asymmetry into the walk and idle (see seedParams). Cached per seed,
 *  so characters that share a seed share their clips.
 *
 *  Call it before the character's first crossfade. It drops the actions
 *  cached for the old seed, but whatever is already playing, fading or being
 *  corrected by inertia keeps running on the clips it was built from — this
 *  is a constructor-time knob, not a live one. */
export function setSeed(obj, seed) {
  const rig = rigOf(obj)
  seed = seed >>> 0
  if (rig.seed === seed) return
  rig.seed = seed
  rig.actions.clear()
}

/**
 * Configured AnimationAction for a character + clip name.
 * One-shots clamp on their last frame so sit/highfive hold their end pose.
 */
export function makeAction(obj, name, { timeScale = 1 } = {}) {
  const rig = rigOf(obj)
  let a = rig.actions.get(name)
  if (!a) {
    const clip = getClip(name, rig.seed)
    a = rig.mixer.clipAction(clip)
    if (clip.userData.oneShot) { a.setLoop(THREE.LoopOnce, 1); a.clampWhenFinished = true }
    else a.setLoop(THREE.LoopRepeat, Infinity)
    rig.actions.set(name, a)
  }
  a.timeScale = timeScale
  return a
}

// -- crossfade: eased weight ramp + inertialization + phase-aware starts ----
//
// Three's own AnimationAction.crossFadeFrom schedules a LINEAR weight ramp
// (see _updateWeight/_scheduleFading in AnimationAction.js) and there's no
// hook to change the curve. So this drives both actions' weights itself,
// once per update(), through `ease()` — the same smoothstep the one-shot
// poses already use — instead of handing that off to the mixer.
//
// A genuine two-action fade (prev and next both playing, weights ramping
// (1,0) -> (0,1)) is continuous at the seam by construction: at u=0 the
// mixer's normalised blend of the two actions IS prev's own pose, no
// interpolation error possible. There's exactly one case that isn't true —
// retriggering the clip that's already current (prev === next, e.g.
// re-playing highfive), which has only one action and so no ramp to be
// continuous with: next.reset() cuts it straight back to its own frame 0.
// That's where inertialization earns its keep: it captures a per-bone
// rotation offset between whatever pose was on screen and the clip's own
// pose at its restart phase, then decays that offset to identity over
// `duration` as a post-mixer pass (see applyInertia) — so the retrigger
// steps continuously out of wherever the clip was instead of snapping back
// to frame 0.
const BIG_BONES = ['Hips', 'LeftUpLeg', 'RightUpLeg', 'LeftArm', 'RightArm', 'Spine02']
const PHASE_SAMPLES = 8
const INERTIA_EPS = 0.5 * D2R   // sub-half-degree offsets aren't worth carrying

const _bsA = new THREE.Quaternion(), _bsB = new THREE.Quaternion()

/** Exact LINEAR-interpolated pose of one bone at a normalised phase, read
 *  straight from a clip's baked keyframe arrays (clip.userData.bake) rather
 *  than through a mixer/interpolant — used for phase matching and
 *  inertialization, both of which need a pose from a clip that may not be
 *  the one actually driving the mixer yet. */
function bakeSample(clip, bone, phase, out) {
  const bake = clip.userData.bake
  const arr = bake.rot[bone]
  const n = bake.n
  const idx = Math.min(1, Math.max(0, phase)) * (n - 1)
  const i0 = Math.floor(idx), i1 = Math.min(i0 + 1, n - 1)
  _bsA.set(arr[i0 * 4], arr[i0 * 4 + 1], arr[i0 * 4 + 2], arr[i0 * 4 + 3])
  _bsB.set(arr[i1 * 4], arr[i1 * 4 + 1], arr[i1 * 4 + 2], arr[i1 * 4 + 3])
  return out.copy(_bsA).slerp(_bsB, idx - i0)
}

function quatAngle(a, b) {
  const d = Math.min(1, Math.abs(a.x * b.x + a.y * b.y + a.z * b.z + a.w * b.w))
  return 2 * Math.acos(d)
}

const _pmQ = new THREE.Quaternion()

/** Phase of `next`'s clip whose pose is closest (summed angular distance
 *  over the big bones) to what's on screen right now. Used when fading into
 *  a loop from a clip of a different shape, so the new cycle doesn't start
 *  out of step with the body it's replacing — walk->walk instead reuses the
 *  outgoing action's own time, which crossfade() handles separately. */
function phaseMatch(obj, rig, next) {
  const bones = boneMap(obj, rig)
  const clip = next.getClip()
  let best = 0, bestDist = Infinity
  for (let i = 0; i < PHASE_SAMPLES; i++) {
    const phase = i / PHASE_SAMPLES
    let dist = 0
    for (const name of BIG_BONES) {
      const b = bones[name]
      if (!b) continue
      dist += quatAngle(b.quaternion, bakeSample(clip, name, phase, _pmQ))
    }
    if (dist < bestDist) { bestDist = dist; best = phase }
  }
  return best
}

/** Every bone's current local quaternion, for the outgoing side of an
 *  inertialization offset. */
function snapshotPose(obj, rig) {
  const bones = boneMap(obj, rig)
  const out = {}
  for (const n of BONES) { const b = bones[n]; if (b) out[n] = b.quaternion.clone() }
  return out
}

/** An action's current time as a phase in [0, 1], clamped — used to sample
 *  clip.userData.bake rather than the mixer. */
function actionPhase(action) {
  const dur = action.getClip().duration
  return dur > 0 ? Math.min(1, Math.max(0, action.time / dur)) : 0
}

const _iqTarget = new THREE.Quaternion(), _iqInv = new THREE.Quaternion(), _iqOffset = new THREE.Quaternion()

/** Arm rig.inertia from `outgoing` (the pose just before this transition) to
 *  `next`'s own pose at its start phase. Stores, per bone, the rotation that
 *  turns next's pose back into the outgoing one; applyInertia decays that to
 *  identity over `duration`, recomputing next's own pose fresh every frame
 *  from `action` rather than reading it off the bone (see applyInertia for
 *  why). */
function armInertia(obj, rig, next, outgoing, duration) {
  const clip = next.getClip()
  if (!clip.userData.bake) { rig.inertia = null; return }
  const phase = actionPhase(next)
  const offsets = new Map()
  for (const name in outgoing) {
    if (!clip.userData.bake.rot[name]) continue
    bakeSample(clip, name, phase, _iqTarget)
    _iqInv.copy(_iqTarget).invert()
    _iqOffset.copy(outgoing[name]).multiply(_iqInv)
    if (quatAngle(_iqOffset, IDENTITY_Q) > INERTIA_EPS) offsets.set(name, _iqOffset.clone())
  }
  rig.inertia = offsets.size ? { action: next, offsets, dur: Math.max(duration, 1 / 60), t: 0 } : null
}

const IDENTITY_Q = new THREE.Quaternion()

/**
 * Blend from whatever is playing into `name`. Returns the incoming action.
 * Restarts one-shots so sit/highfive can be re-triggered.
 */
export function crossfade(obj, name, duration = 0.35, opts = {}) {
  const rig = rigOf(obj)
  const next = makeAction(obj, name, opts)
  let prev = rig.current

  if (prev === next && !ONE_SHOT.has(name)) return next

  // A fade already in flight is finished on the spot rather than layering a
  // third action on top of it, and its target becomes this call's prev. That
  // is NOT free: what was on screen was blend(A, B, w) and what prev alone
  // shows is B, so the pose jumps by (1 - w) of the distance between them in
  // one frame. `interrupted` says so, and the branch below pays it off with
  // the same inertia offset a retrigger uses.
  let interrupted = false
  if (rig.fade) {
    rig.fade.prev.enabled = false
    rig.fade.prev.setEffectiveWeight(0)
    rig.fade.next.setEffectiveWeight(1)
    prev = rig.fade.next
    rig.fade = null
    interrupted = true
  }

  const retrigger = prev === next
  const outgoing = prev ? snapshotPose(obj, rig) : null

  next.enabled = true
  if (retrigger || ONE_SHOT.has(name)) next.reset()

  if (prev && !retrigger) {
    // Sync the phase on cycles of similar shape so the feet do not teleport;
    // otherwise start the loop wherever it already looks like the outgoing
    // pose so the cut into it isn't out of step with the body.
    if (name === 'walk' && prev.getClip().name === 'walk') next.time = prev.time
    else if (next.getClip().userData.loop) next.time = phaseMatch(obj, rig, next) * next.getClip().duration
  }

  if (prev && !retrigger) {
    // Two actions ramping from (1, 0) to (0, 1) are continuous at the seam by
    // construction — at u=0 the mixer's normalised blend IS prev's own pose,
    // no interpolation error possible — so a fade that starts from a settled
    // pose needs no inertia. The exception is `interrupted`: prev is then the
    // target of a fade that was still mid-ramp, so prev's own pose is NOT
    // what was on screen. Same fix as the retrigger below — carry the real
    // outgoing pose as a decaying offset — and the same cap, so it is spent
    // before this fade ends and freezes prev.time.
    if (interrupted) armInertia(obj, rig, prev, outgoing, 0.8 * duration)
    // Any inertia still correcting `prev` from an earlier retrigger has to
    // stop targeting prev in isolation once this fade starts blending prev
    // against next — applyInertia's target is only valid while prev is the
    // sole thing driving that bone (see applyInertia). It doesn't get
    // dropped, though: applyInertia composes it with the blend itself once
    // rig.fade is live, so the offset keeps decaying against a moving target
    // instead of being paid off in one step. It's capped to finish strictly
    // before this fade does — otherwise the fade would complete, disable
    // prev, freeze prev.time, and leave the still-live offset correcting a
    // pose that's stopped updating.
    if (rig.inertia) {
      const remaining = rig.inertia.dur - rig.inertia.t
      rig.inertia.dur = rig.inertia.t + Math.min(remaining, 0.8 * duration)
    }
    prev.enabled = true
    prev.setEffectiveWeight(1)
    next.setEffectiveWeight(0)
    rig.fade = { prev, next, dur: duration, t: 0 }
  } else {
    next.setEffectiveWeight(1)
    if (outgoing) armInertia(obj, rig, next, outgoing, duration)
  }

  next.play()
  rig.current = next
  return next
}

const _inTmp = new THREE.Quaternion(), _inAnimated = new THREE.Quaternion()
const _inA = new THREE.Quaternion(), _inB = new THREE.Quaternion()

/** Post-mixer correction: decays rig.inertia's per-bone offset to identity
 *  (cubic ease-out) and composes it onto that bone's pose, so the pose steps
 *  continuously out of whatever was on screen before the transition instead
 *  of snapping onto the new clip's own pose.
 *
 *  This recomputes the "animated" pose itself — bakeSample against the live
 *  action's current time, or, if a fade is running (a second crossfade
 *  interrupted the retrigger this offset came from — see the cap in
 *  crossfade()), the two fade actions' own poses slerped by the same eased
 *  weight update() just gave them — rather than reading bone.quaternion and
 *  premultiplying in place. PropertyMixer.apply() only writes a bone's
 *  quaternion when its newly-accumulated value differs from last frame's
 *  (see apply() in PropertyMixer.js) — a retriggered one-shot often holds
 *  the exact same pose for several frames in a row (see armInertia's caller:
 *  it only fires on a retrigger, which starts most clips near a still
 *  opening pose), so the mixer would silently skip its own write and leave
 *  whatever this function last wrote sitting there. Premultiplying onto that
 *  would compound the same correction into itself frame after frame — so
 *  every branch below computes the animated pose fresh and OVERWRITES with
 *  it, never premultiplies. */
function applyInertia(obj, rig, dt) {
  const inertia = rig.inertia
  if (!inertia) return
  inertia.t += dt
  // dur can be capped to exactly t by an interrupting zero-length fade, and
  // dt can be 0 on a frame; t/dur is then 0/0, and a NaN written to a bone
  // here sticks — PropertyMixer only rewrites a bone whose accumulated value
  // changed, so the legs stay NaN for good.
  const u = inertia.dur > 0 ? Math.min(1, inertia.t / inertia.dur) : 1
  const decay = (1 - u) ** 3
  if (decay <= 1e-3) { rig.inertia = null; return }
  const bones = boneMap(obj, rig)
  const fade = rig.fade
  if (fade) {
    const clipA = fade.prev.getClip(), clipB = fade.next.getClip()
    const bakeA = clipA.userData.bake, bakeB = clipB.userData.bake
    const phaseA = actionPhase(fade.prev), phaseB = actionPhase(fade.next)
    const w = fade.dur > 0 ? ease(fade.t / fade.dur, 0, 1) : 1   // same curve update() drove the weights with this frame
    for (const [name, offset] of inertia.offsets) {
      const b = bones[name]
      if (!b || !bakeA.rot[name] || !bakeB.rot[name]) continue
      bakeSample(clipA, name, phaseA, _inA)
      bakeSample(clipB, name, phaseB, _inB)
      _inAnimated.copy(_inA).slerp(_inB, w)
      _inTmp.copy(IDENTITY_Q).slerp(offset, decay)
      b.quaternion.copy(_inTmp).multiply(_inAnimated)
    }
  } else {
    const clip = inertia.action.getClip()
    const bake = clip.userData.bake
    const phase = actionPhase(inertia.action)
    for (const [name, offset] of inertia.offsets) {
      const b = bones[name]
      if (!b || !bake.rot[name]) continue
      bakeSample(clip, name, phase, _inAnimated)
      _inTmp.copy(IDENTITY_Q).slerp(offset, decay)
      b.quaternion.copy(_inTmp).multiply(_inAnimated)
    }
  }
}

/** Per-bone angular velocity this frame, for popMetric. */
function trackVelocity(obj, rig, dt) {
  if (dt <= 0) return
  const bones = boneMap(obj, rig)
  if (!rig.prevQuats) rig.prevQuats = new Map()
  let maxVel = 0
  for (const n of BONES) {
    const b = bones[n]
    if (!b) continue
    const prev = rig.prevQuats.get(n)
    if (prev) {
      const vel = quatAngle(prev, b.quaternion) / dt
      if (vel > maxVel) maxVel = vel
      prev.copy(b.quaternion)
    } else {
      rig.prevQuats.set(n, b.quaternion.clone())
    }
  }
  rig.maxAngVel = maxVel
}

/** Advance one character's mixer, ramp any in-flight crossfade weight, and
 *  apply the decaying inertialization offset on top. */
export function update(obj, dt) {
  const rig = rigOf(obj)
  const f = rig.fade
  if (f) {
    f.t += dt
    const u = f.dur > 0 ? Math.min(1, f.t / f.dur) : 1
    const w = ease(u, 0, 1)   // smoothstep, not the linear ramp crossFadeFrom used
    f.next.setEffectiveWeight(w)
    f.prev.setEffectiveWeight(1 - w)
    if (u >= 1) {
      f.prev.enabled = false
      f.prev.setEffectiveWeight(0)
      rig.fade = null
    }
  }
  rig.mixer.update(dt)
  applyInertia(obj, rig, dt)
  trackVelocity(obj, rig, dt)
}

/** Max per-bone angular velocity (rad/s) measured on this character's last
 *  update() call. A transition popping should show up here as a spike well
 *  past whatever the same clip's own peak looks like in steady state. */
export function popMetric(obj) {
  const rig = RIGS.get(obj)
  return rig ? rig.maxAngVel : 0
}

/** Nudge a cached action's timeScale without touching what's currently
 *  playing or armed. Used by the churn signal (agent.js's setChurn) to make
 *  typing read faster on a hot file — a normal crossfade would restart the
 *  clip and reset the phase, this just turns the same action's dial. No-op
 *  if the named action has never been created for this object yet. */
export function setTimeScale(obj, name, timeScale) {
  const r = RIGS.get(obj)
  const a = r && r.actions.get(name)
  if (a) a.timeScale = timeScale
}

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
