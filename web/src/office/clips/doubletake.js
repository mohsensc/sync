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
// authored as its own named, tunable window (`pauseS` in buildDoubletakeTiming
// below) rather than left to fall out of two overlapping bump()s.
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
// Beat timing. Segment lengths in SECONDS, not fractions, and built by a
// factory rather than hand-picked fractions — see round 2 task 4's own
// notes in STATE.md: this clip was "a first draft off the pose math alone,
// not off how it actually reads," and the two things a visual pass actually
// needed to touch were (a) whether the pause holds still long enough to
// read as a pause, and (b) whether the snap has enough SAMPLES to look
// sudden rather than mushy. Seconds, not fractions, because "longer pause"
// should only grow the pause — with fractions of a fixed total, stretching
// one segment silently stretches (or the total silently swallows) the
// others, and the snap is the one segment that must never get slower.
// ---------------------------------------------------------------------------
const DT_LOOK1_S = 0.364   // already looking at the start of the clip
const DT_AWAY_S  = 0.416   // glances off — "wait, that looks familiar..."
const DT_SNAP_S  = 0.208   // FAST — the actual double-take, back in <0.3s
const DT_HOLD_S  = 0.312   // wide-eyed hold on the partner
const DT_SHRUG_S = 0.624   // palms up, "...oh, you too"
const DT_REST_S  = 0.260   // eases back to rest

/** Segment table + total duration for a given pause length (seconds) and
 *  shrug peak amplitude. Returns [end t, headYaw, headNod, browRaise,
 *  shrugK, easing] rows — brow raise has no dedicated bone, so it rides the
 *  neck/Head nod's sign instead (a small upward tip reads as "surprised" on
 *  this rig — same trick the argue/react clips use for their head shake).
 *  `shrugAmp` is just the shrug segment's target K: shrugRight(k) is a
 *  plain mix(a,b,k), so K > 1 extrapolates past the authored pose instead
 *  of clamping — the cheapest possible "bigger shrug" knob. */
function buildDoubletakeTiming(pauseS, shrugAmp) {
  const durs = [DT_LOOK1_S, DT_AWAY_S, pauseS, DT_SNAP_S, DT_HOLD_S, DT_SHRUG_S, DT_REST_S]
  const dur = durs.reduce((a, b) => a + b, 0)
  let acc = 0
  const ends = durs.map(d => { acc += d; return acc / dur })
  const segs = [
    [ends[0], 0,  0,  0,  0,        smooth],
    [ends[1], -22, 4, -1, 0,        smooth],
    [ends[2], -22, 4, -1, 0,        u => u],                 // hold the away-look
    [ends[3],  4, -6,  3, 0,        u => Math.pow(u, 0.4)],  // snap: fast in, no ease-out
    [ends[4],  4, -6,  3, 0,        u => u],                 // hold the wide-eyed look
    [ends[5],  0,  2,  1, shrugAmp, smooth],
    [ends[6],  0,  0,  0, 0,        smooth],
  ]
  return { dur, segs, pauseS, shrugAmp }
}

function dtBlend(t, segs) {
  let i = 0
  while (i < segs.length - 1 && t >= segs[i][0]) i++
  const row = segs[i]
  const prev = i === 0 ? row : segs[i - 1]  // first window holds row0's own values from t=0
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

// The picked take: pause length and shrug amplitude match the original
// first-draft values exactly (0.416s pause, shrug K peaks at 1) — the visual
// pass didn't find the STRUCTURE wrong, just the sampling (below) and it's
// worth comparing against the two variants to confirm that's still true.
const DEFAULT_TIMING = buildDoubletakeTiming(0.416, 1)

// Alternate takes for side-by-side comparison in doubletake-test.html only
// — neither is folded into ANIM.CLIPS, neither is reachable from World.
//   longPause — the hold before the snap stretched by half a second, to
//     check whether the joke actually plays better with more "wait for it."
//   bigShrug  — the "oh, you too" amplified 40%, same timing otherwise.
const LONGPAUSE_TIMING = buildDoubletakeTiming(0.416 + 0.5, 1)
const BIGSHRUG_TIMING = buildDoubletakeTiming(0.416, 1.4)

export { DEFAULT_TIMING, LONGPAUSE_TIMING, BIGSHRUG_TIMING }

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

function doubletakePose(t, timing = DEFAULT_TIMING) {
  const { yaw, nod, brow, shrug } = dtBlend(t, timing.segs)
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
// Clip specs
// ---------------------------------------------------------------------------
export const DOUBLETAKE_DUR = DEFAULT_TIMING.dur

// Key density in samples/SECOND, not a flat key count. The snap is a fixed
// 0.208s regardless of which timing variant is playing, but the total
// duration isn't (longPause is ~0.5s longer) — a flat key count would
// under-sample the snap on the longer variant even though it left the snap
// itself untouched. The visual pass this round found the snap under-sampled
// at the original flat 40 keys/2.6s: 0.208s / (2.6/39) is only ~3.1 samples
// across the whole fast-in window, and the brief's own rule of thumb is
// "under ~4 frames of easing and it mushes." 40 keys/sec puts ~8 samples
// across the snap on every variant here, comfortably clear of that line.
const DT_KEY_DENSITY = 40
function keysFor(dur) { return Math.round(dur * DT_KEY_DENSITY) + 1 }

function specFor(timing) {
  return { fn: t => doubletakePose(t, timing), dur: timing.dur, keys: keysFor(timing.dur), loop: false }
}

const DOUBLETAKE_SPEC = specFor(DEFAULT_TIMING)

/** Registry an integrator can fold straight into anim.js's own CLIPS table.
 *  This is the picked take — the only one World ever sees. */
export const registry = { doubletake: DOUBLETAKE_SPEC }

// Alternate takes for comparison in doubletake-test.html only — neither is
// folded into ANIM.CLIPS, neither is reachable from World.
export const variants = {
  default: registry,
  longPause: { doubletake: specFor(LONGPAUSE_TIMING) },
  bigShrug: { doubletake: specFor(BIGSHRUG_TIMING) },
}

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

const _clipsByRegistry = new WeakMap()
/** Build (and memoise) the doubletake AnimationClip. Takes an optional
 *  registry (`variants.longPause` etc) so the test harness can scrub an
 *  alternate take without this file growing a second getClip. */
export function getClip(reg = registry) {
  let cache = _clipsByRegistry.get(reg)
  if (!cache) { cache = {}; _clipsByRegistry.set(reg, cache) }
  if (!cache.doubletake) cache.doubletake = buildClipFromSpec('doubletake', reg.doubletake)
  return cache.doubletake
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
export function playDoubletake(root, fade = 0.16, reg = registry) {
  const idle = ANIM.makeAction(root, 'idle')
  const mixer = ANIM.getMixer(root)
  const clip = getClip(reg)
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
