// Facepalm: an alternate rung-4 "redundant work" beat, alongside
// doubletake.js. Same situation — two agents discover they built the same
// thing twice — but where doubletake plays it as a mirrored, symmetric
// "wait, you too?", this one splits the reaction: `a` facepalms, `b`
// shrugs. Nobody won anything (see the doc comment on REPLAY_CHAINS.wait
// for the general "no winner/loser framing here" pattern this shares with
// yield.js) — it's just two different ways of being annoyed at the same
// wasted afternoon.
//
//   facepalm — `a`. A beat of realization, then the hand comes all the way
//     up to cover the face and stays there, head dropping into it.
//   shrug    — `b`. The same beat of realization, then shoulders and arms
//     rise into an open "well, what do you want me to do about it" shrug
//     and hold.
//
// Both end mid-gesture (hand fully on the face / arms fully up), not back
// at rest — same reasoning as tiptoe.js's own note: agent.js's
// REPLAY_CHAINS layers a short procedural sway on top of whatever frame a
// clip ends on (clips/sustain.js), so the payoff has to actually be the
// held frame.
//
// WHY THIS FILE BUILDS ITS OWN CLIPS — same story as every other paired
// clip module here (see tiptoe.js/yield.js/handshake.js): anim.js exports
// applyPose but not the pose-function-to-AnimationClip internals, so this
// file builds its own scratch rig from anim.js's own BIND data.
//
// No IK anywhere. Marks are the primitive; the controller owns the pathing.

import * as THREE from 'three'
import * as ANIM from '../anim.js'
import { highfiveMarks, CHARACTER_HEIGHT } from '../highfive.js'

const smooth = u => u * u * (3 - 2 * u)
const wrap = p => ((p % 1) + 1) % 1

/** Same three-line raised cosine as tiptoe.js/yield.js's own copies. */
function bump(p, centre, width) {
  const d = wrap(p - centre + 0.5) - 0.5
  const h = width * 0.5
  if (Math.abs(d) >= h) return 0
  return 0.5 * (1 + Math.cos(Math.PI * d / h))
}

/** 0 before `start`, smoothsteps to 1 over `rise`, holds at 1 after — see
 *  tiptoe.js's own copy for why this (not bump()) drives the payoff. */
function riseHold(t, start, rise) {
  if (t <= start) return 0
  if (t >= start + rise) return 1
  return smooth((t - start) / rise)
}

function pose(...parts) {
  const o = {}
  for (const p of parts) if (p) for (const k in p) o[k] = p[k]
  return o
}

// ---------------------------------------------------------------------------
// Timing — a shared "wait, is that..." realization beat (both sides do the
// same small double-take), then they diverge.
// ---------------------------------------------------------------------------
export const FACEPALM_DUR = 1.7
const REALIZE_PEAK = 0.22, REALIZE_WIDTH = 0.30   // both: the shared "...you too?" beat
const RISE_START = 0.32, RISE_WIDTH = 0.40         // both: the gesture that actually differs

// ---------------------------------------------------------------------------
// facepalm — `a`
// ---------------------------------------------------------------------------
function facepalmPose(t) {
  const realize = bump(t, REALIZE_PEAK, REALIZE_WIDTH)
  const rise = riseHold(t, RISE_START, RISE_WIDTH)

  return pose(ANIM.STANDING,
    { hips: [0, 0, 0], Hips: [0, -3 * rise, 0] },
    {
      Spine02: [-2 * realize + 6 * rise, 4 * rise, 0],
      Spine01: [-1 * realize + 4 * rise, 3 * rise, 0],
      Spine:   [4 * rise, 2 * rise, 0],
      neck:    [-6 * realize + 10 * rise, -3 * rise, 0],
      Head:    [-10 * realize + 22 * rise, -5 * rise, 4 * rise],
    },
    // Right hand rises to cover the face — elbow lifts out and up, forearm
    // folds the hand in toward the head. Left arm stays low, slack.
    {
      RightShoulder: [0, -4 - 6 * rise, 8 * rise],
      RightArm: [-8 - 30 * realize - 60 * rise, 12 - 10 * rise, 10 + 50 * rise],
      RightForeArm: [0, 16 + 118 * rise, 0],
      RightHand: [8, 4, 0], RightPalm: [0.1, 0.7, -0.7],
      LeftShoulder: [0, 2, -4], LeftArm: [-6 + 2 * realize, -10, -70 - 10 * rise],
      LeftForeArm: [0, -14, 0], LeftHand: [4, -3, 0], LeftPalm: [0.2, -0.85, -0.3],
    })
}

// ---------------------------------------------------------------------------
// shrug — `b`
// ---------------------------------------------------------------------------
function shrugPose(t) {
  const realize = bump(t, REALIZE_PEAK, REALIZE_WIDTH)
  const rise = riseHold(t, RISE_START, RISE_WIDTH)

  return pose(ANIM.STANDING,
    { hips: [0, 0, 0], Hips: [0, 4 * rise, 0] },
    {
      Spine02: [-2 * realize - 1 * rise, -3 * rise, 0],
      Spine01: [-1 * realize, -2 * rise, 0],
      Spine:   [-1 * rise, -1 * rise, 0],
      neck:    [-6 * realize + 4 * rise, 2 * rise, 0],
      Head:    [-8 * realize + 6 * rise, 3 * rise, -3 * rise],
    },
    // Both shoulders hike up, both arms swing out and up into an open
    // palms-up shrug — the mirrorable "same clip both ways" shape isn't
    // used here (facepalm/shrug are two different clips, not one mirrored
    // pair), so both sides are authored explicitly.
    {
      LeftShoulder: [0, 3, -14 * rise], RightShoulder: [0, -3, 14 * rise],
      LeftArm: [-6 - 20 * realize - 40 * rise, -10, -70 + 34 * rise],
      RightArm: [-6 - 20 * realize - 40 * rise, 10, 70 - 34 * rise],
      LeftForeArm: [0, -14 - 70 * rise, 0], RightForeArm: [0, 14 + 70 * rise, 0],
      LeftHand: [4, -3, 0], RightHand: [4, 3, 0],
      LeftPalm: [0.1, -0.3, 0.85], RightPalm: [0.1, 0.3, 0.85],
    })
}

// ---------------------------------------------------------------------------
// Scratch rig — identical topology to tiptoe.js/yield.js's own copies.
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

// 26 keys over 1.7s: nothing here is fast (no contact frame to hit, unlike
// slap.js) — the realization bump is the narrowest feature at 0.30 clip-
// width, comfortably oversampled at this rate.
const FACEPALM_KEYS = 26
export const FACEPALM_SPEC = { fn: facepalmPose, dur: FACEPALM_DUR, keys: FACEPALM_KEYS, loop: false }
export const SHRUG_SPEC = { fn: shrugPose, dur: FACEPALM_DUR, keys: FACEPALM_KEYS, loop: false }

export const registry = { facepalm: FACEPALM_SPEC, shrug: SHRUG_SPEC }

const _clips = {}
export function getClip(name) {
  if (!registry[name]) throw new Error(`facepalm: no clip "${name}". Have: ${Object.keys(registry).join(', ')}`)
  if (!_clips[name]) _clips[name] = buildClipFromSpec(name, registry[name])
  return _clips[name]
}

// ---------------------------------------------------------------------------
// Spacing and marks — mutual, not a contact action, chosen directly. A bit
// closer than doubletake's 1.35: that one is a big mirrored double-take,
// this is two people quietly dying inside next to each other.
// ---------------------------------------------------------------------------
export const FACEPALM_SPACING = 1.05

export function spacingFor(height = CHARACTER_HEIGHT) {
  return FACEPALM_SPACING * (height / CHARACTER_HEIGHT)
}

export function facepalmMarks(aPos, bPos, spacing = FACEPALM_SPACING) {
  return highfiveMarks(aPos, bPos, spacing)
}
