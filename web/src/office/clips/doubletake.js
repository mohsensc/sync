// Double take: rung 4, redundant work discovered. Two agents notice — after
// the fact — that they were both doing the same thing in different files.
// Nobody was wrong, nobody blocked anybody, it's just funny.
//
// Symmetric pair, same shape highfive.js/handshake.js use: both characters
// play the SAME clip, and facing each other across the marks is already the
// mirror. The comic timing lives entirely in the beat structure, not the
// pose extremes:
//
//   look (at the partner) -> away (a beat of "wait...") -> SNAP back (fast,
//   the actual double-take) -> hold -> palms-up "oh, you too" shrug -> rest
//
// The pause between the first and second look is the whole joke, so it's
// authored as its own named window (DT_PAUSE) rather than left to fall out
// of two overlapping bump()s — see doubletakePose below.
//
// Not a contact action (nobody touches), so like argue.js and yield.js the
// marks distance is chosen directly rather than measured off a contact
// point.
//
// WHY THIS FILE BUILDS ITS OWN CLIP
// Same reason as every other file in clips/: anim.js exports applyPose but
// not the pose-function-to-AnimationClip pipeline. Scratch rig off
// anim.js's own BIND data, replay applyPose per sample, read back the
// quaternions. See handshake.js's header for the long version.
//
// No IK. Marks are the primitive; the controller owns the pathing.

import * as THREE from 'three'
import * as ANIM from '../anim.js'
import { highfiveMarks, yawTowards, walkScale, CHARACTER_HEIGHT } from '../highfive.js'

const TAU = Math.PI * 2
const wrap = p => ((p % 1) + 1) % 1
const mix = (a, b, t) => a + (b - a) * t
const clamp01 = u => Math.max(0, Math.min(1, u))
const smooth = u => u * u * (3 - 2 * u)

function pose(...parts) {
  const o = {}
  for (const p of parts) if (p) for (const k in p) o[k] = p[k]
  return o
}

// ---------------------------------------------------------------------------
// Beat timing. Named windows, not bump()s laid on top of each other, because
// the GAP between look-away and snap-back is the punchline and needs to be
// an honest, tunable number rather than an emergent side effect.
// ---------------------------------------------------------------------------
const DT_LOOK1_END  = 0.14   // already looking at the start of the clip
const DT_AWAY_END   = 0.30   // glances off — "wait, that looks familiar..."
const DT_PAUSE_END  = 0.46   // the hold. Comic timing lives in this gap.
const DT_SNAP_END   = 0.54   // FAST — the actual double-take, back in <0.3s
const DT_HOLD_END   = 0.66   // wide-eyed hold on the partner
const DT_SHRUG_END  = 0.90   // palms up, "...oh, you too"
// 1.0: eases back to rest

/** Segment table: [end t, headYaw, headNod, browRaise, shrugK, easing]. brow
 *  raise has no dedicated bone, so it rides the neck/Head nod's sign instead
 *  (a small upward tip reads as "surprised" on this rig — same trick the
 *  argue/react clips use for their head shake). */
const DT_SEGS = [
  [DT_LOOK1_END, 0,  0,  0,  0, smooth],
  [DT_AWAY_END, -22, 4, -1, 0, smooth],
  [DT_PAUSE_END, -22, 4, -1, 0, u => u],           // hold the away-look
  [DT_SNAP_END,  4, -6,  3, 0, u => Math.pow(u, 0.4)],  // snap: fast in, no ease-out
  [DT_HOLD_END,  4, -6,  3, 0, u => u],             // hold the wide-eyed look
  [DT_SHRUG_END, 0,  2,  1, 1, smooth],
  [1.00,         0,  0,  0, 0, smooth],
]

function dtBlend(t) {
  let i = 0
  while (i < DT_SEGS.length - 1 && t >= DT_SEGS[i][0]) i++
  const row = DT_SEGS[i]
  const prev = i === 0 ? row : DT_SEGS[i - 1]  // first window holds row0's own values from t=0
  const t0 = i === 0 ? 0 : prev[0]
  const t1 = row[0]
  const [, yaw, nod, brow, shrug, easing] = row
  const u = easing(clamp01(t1 === t0 ? 1 : (t - t0) / (t1 - t0)))
  return {
    yaw: mix(prev[1], yaw, u),
    nod: mix(prev[2], nod, u),
    brow: mix(prev[3], brow, u),
    shrug: mix(prev[4], shrug, u),
  }
}

// Shrug arms: both come up and out, palms up, shoulders lift a touch — the
// universal "not my fault" gesture. Symmetric (LeftArm mirrors RightArm),
// so it's authored once and mirrored with ANIM.mirrorPose, same trick
// handshake.js's off-arm and argue.js's handsUp() use.
function shrugRight(k) {
  return {
    RightShoulder: [0, mix(2, -4, k), mix(2, 18, k)],
    RightArm:      [mix(-4, -30, k), mix(8, 34, k), mix(99, 20, k)],
    RightForeArm:  [0, mix(16, 88, k), 0],
    RightHand:     [mix(5, -8, k), mix(4, 6, k), 0],
    RightPalm:     [mix(1, 0.05, k), mix(-0.05, 0.90, k), mix(-0.32, 0.20, k)],
  }
}

function doubletakePose(t) {
  const { yaw, nod, brow, shrug } = dtBlend(t)
  return pose(ANIM.STANDING,
    { hips: [0, 0, 0] },
    {
      Spine02: [-1 * brow, yaw * 0.10, 0],
      Spine01: [-1 * brow, yaw * 0.08, 0],
      neck:    [nod, yaw * 0.55, 0],
      Head:    [nod * 1.4 + brow, yaw, 0],
    },
    shrugRight(shrug),
    ANIM.mirrorPose(shrugRight(shrug)))
}

// ---------------------------------------------------------------------------
// Clip spec
// ---------------------------------------------------------------------------
export const DOUBLETAKE_DUR = 2.6
// The snap (DT_AWAY_END -> DT_SNAP_END, 0.24 of the clip = ~0.62s) is the
// fastest thing here and has no zero-slope requirement at its inner edge —
// it's meant to look sudden — so it wants more samples than the smooth
// segments around it. 40 keys over 2.6s is 65ms/sample, enough that the snap
// doesn't facet even sped up with pow(u, 0.4).
const DOUBLETAKE_KEYS = 40

const DOUBLETAKE_SPEC = { fn: doubletakePose, dur: DOUBLETAKE_DUR, keys: DOUBLETAKE_KEYS, loop: false }

/** Registry an integrator can fold straight into anim.js's own CLIPS table. */
export const registry = { doubletake: DOUBLETAKE_SPEC }

// ---------------------------------------------------------------------------
// Scratch rig — same topology every clips/ file carries its own copy of.
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

let _clip = null
/** Build (and memoise) the doubletake AnimationClip. */
export function getClip() {
  if (!_clip) _clip = buildClipFromSpec('doubletake', DOUBLETAKE_SPEC)
  return _clip
}

// ---------------------------------------------------------------------------
// Spacing and marks
// ---------------------------------------------------------------------------
// Not a contact action — chosen directly, same reasoning as argue.js's
// ARGUE_SPACING. Wider than a greeting: redundant work is usually spotted
// from across the room (different files, different desks), so the beat
// reads better with real air between the pair rather than a close square-up.
export const DOUBLETAKE_SPACING = 1.35

export function spacingFor(height = CHARACTER_HEIGHT) {
  return DOUBLETAKE_SPACING * (height / CHARACTER_HEIGHT)
}

/** Where the pair have to stand — highfiveMarks already takes spacing as a
 *  plain argument, so there's nothing action-specific left to write here. */
export function doubletakeMarks(aPos, bPos, spacing = DOUBLETAKE_SPACING) {
  return highfiveMarks(aPos, bPos, spacing)
}

// ---------------------------------------------------------------------------
// The pair routine — walk -> settle -> same-frame same-clip start -> done.
// Identical shape to handshakeRoutine, since both are symmetric one-shots.
// ---------------------------------------------------------------------------
function turn(g, yaw, max) {
  const d = ((yaw - g.rotation.y) % TAU + TAU + Math.PI) % TAU - Math.PI
  if (Math.abs(d) <= max) { g.rotation.y = yaw; return true }
  g.rotation.y += Math.sign(d) * max
  return false
}

/** Start the doubletake clip on `root`, crossfading in from whatever the
 *  mixer is currently playing. Not registered in anim.js, so this does what
 *  ANIM.crossfade does but by hand, same per-object mixer cache. */
export function playDoubletake(root, fade = 0.16) {
  const idle = ANIM.makeAction(root, 'idle')
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
export function doubletakeRoutine(a, b, {
  speed = 1.15,
  turnRate = 5.0,
  settle = 0.24,
  arriveEps = 0.006,
  height = CHARACTER_HEIGHT,
} = {}) {
  const spacing = spacingFor(height)
  const marks = doubletakeMarks(a.group.position, b.group.position, spacing)
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
        const d = new THREE.Vector3().subVectors(l.mark.pos, g.position); d.y = 0
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
        for (const l of legs) playDoubletake(l.c.root)
        phase = 'take'; clock = 0
      }
    } else if (phase === 'take') {
      clock += dt
      if (clock >= getClip().duration) phase = 'done'
    }
    for (const l of legs) ANIM.update(l.c.root, dt)
    return phase
  }

  return { step, marks, spacing, get phase() { return phase } }
}
