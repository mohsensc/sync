// Argue: two characters going at it. One points, the other throws both hands
// up. Loops for a while — this is meant to sit under a contested-write beat,
// not resolve to anything.
//
// NOTE ON THE FILENAME: the brief said to put this in clips/social.js. By the
// time this file was written, another agent working the same round had
// already claimed that path for a different paired action (a chest bump).
// Rather than clobber it, this one lives at clips/argue.js instead — same
// deal as the anim-test.html fallback the brief itself describes ("otherwise
// make your own small page"). If an integrator wants everything under one
// module later, that's a rename, not a rewrite.
//
// PAIRED ACTION, BUT NOT A CONTACT ONE. highfive.js's pattern is: one
// canonical spacing, marks on the line between the pair, both clips start on
// the same frame. All of that still applies here — nobody touches, but they
// still have to be standing at a fixed, known distance apart for the two
// gestures to read as aimed at each other instead of two people flailing in
// their own bubble. What's different from highfive/handshake/chestBump is
// that the two characters do NOT play the same clip. "Two characters facing
// each other playing the same clip is already mirrored" is true and useful
// when both sides of the contact are symmetric (a slap, a shake, a bump) —
// it is not what an argument looks like. One person points, the other throws
// their hands up. Those are different bodies doing different things, so this
// file exports two clips, `argue` (the pointer) and `argueReact` (the
// hands-up side), authored to the same duration and phase-offset against each
// other so they read as back-and-forth rather than a synchronized routine.
// Which agent gets which role doesn't depend on which side of the mark they
// land on — the marks always face each other exactly, so "point forward" is
// always "point at the partner" regardless of world position or heading.
//
// WHY THIS FILE BUILDS ITS OWN CLIPS
// Same reason as handshake.js/chestBump: anim.js exports applyPose (which
// already runs the palm-roll solve) but not the internals that turn a pose
// function into an AnimationClip. So this file builds a real bone hierarchy
// straight from anim.js's BIND data, replays applyPose across it once per
// sample, and reads the resulting quaternions/hips position into keyframe
// tracks. That's what anim.js's own buildClip does internally — this just
// drives it from outside instead of from in.
//
// No IK. Marks are the primitive; the controller owns the pathing.

import * as THREE from 'three'
import * as ANIM from '../anim.js'
import { highfiveMarks, yawTowards, walkScale, CHARACTER_HEIGHT, MODEL_HEIGHT_CM } from '../highfive.js'

const TAU = Math.PI * 2

// ---------------------------------------------------------------------------
// Pose-authoring helpers. anim.js keeps these private; three lines of glue
// each, so reimplementing beats reaching into anim.js's internals.
// ---------------------------------------------------------------------------
const wrap = p => ((p % 1) + 1) % 1
const sin = (p, k = 1) => Math.sin(TAU * k * p)
const mix = (a, b, t) => a + (b - a) * t

/** Periodic raised cosine: 1 at `centre`, 0 outside `width`, zero slope at
 *  the edges. Exactly anim.js's `bump` — same shape, same reason: a gesture
 *  that eases in and out without a corner, and is trivially loop-periodic
 *  because it's built from wrap(). */
function bump(p, centre, width) {
  const d = wrap(p - centre + 0.5) - 0.5
  const h = width * 0.5
  if (Math.abs(d) >= h) return 0
  return 0.5 * (1 + Math.cos(Math.PI * d / h))
}

/** Merge pose fragments left to right, later wins. */
function pose(...parts) {
  const o = {}
  for (const p of parts) if (p) for (const k in p) o[k] = p[k]
  return o
}

// ---------------------------------------------------------------------------
// Torso: the shared "leaning into it" shape both roles use. Lean folds the
// spine forward (Spine02 first — it's the belly, see anim.js's header on the
// inverted chain); twist rotates it under a partly-compensating neck so the
// character keeps looking at the other person instead of past their shoulder,
// same trick highfive.js's clip uses.
function torso(lean, twist, nod) {
  return {
    Spine02: [lean * 0.45, twist * 0.34, 0],
    Spine01: [lean * 0.30, twist * 0.33, 0],
    Spine:   [lean * 0.25, twist * 0.33, 0],
    neck:    [nod * 0.4, -twist * 0.30, 0],
    Head:    [nod, -twist * 0.60, 0],
  }
}

// ---------------------------------------------------------------------------
// argue — the pointer
// ---------------------------------------------------------------------------
// Two jabs per cycle, alternating hands (mirrorPose gives the left one for
// free from the right one's numbers), so "alternating gesticulation" is
// literal: right hand jabs, retracts, left hand jabs, retracts, repeat. k=0
// is arms-at-rest (ANIM.STANDING's own right arm), k=1 is full extension —
// bump() drives k so both ends land exactly on rest, which is what keeps the
// loop seam at zero without a dedicated rest key.
function rightPoint(k) {
  return {
    RightShoulder: [0, mix(2, 8, k), mix(2, -10, k)],
    RightArm:      [mix(-4, -44, k), mix(8, 40, k), mix(99, 10, k)],
    RightForeArm:  [0, mix(16, 12, k), 0],
    RightHand:     [mix(5, -14, k), mix(4, 8, k), 0],
    // Palm target, not a hand-picked roll — see anim.js's PALM AIMING note.
    // Down-and-forward: an accusatory jab, not a raised greeting.
    RightPalm:     [mix(1, -0.08, k), mix(-0.05, -0.12, k), mix(-0.32, 0.94, k)],
  }
}

function arguePose(t) {
  const jabR = bump(t, 0.15, 0.30)
  const jabL = bump(t, 0.65, 0.30)
  const active = Math.max(jabR, jabL)
  const twist = 9 * jabR - 9 * jabL
  const lean = 6 + 6 * active
  const weight = 1.3 * (jabR - jabL)
  return pose(ANIM.STANDING,
    torso(lean, twist, 4 * active),
    // No hips translation for the lean — the feet hang off the hips, so
    // dragging the pelvis forward would drag them across the floor with it.
    // Same rule highfive.js's and handshake.js's clips follow. A small hips
    // YAW is fine (it just pivots the stance a couple of degrees under the
    // twist) and stays well inside what highfive's own HF_CONTACT already
    // does (4 degrees there).
    { hips: [weight, 0, 0], Hips: [0, 3 * (jabR - jabL), 0] },
    rightPoint(jabR),
    ANIM.mirrorPose(rightPoint(jabL)))
}

// ---------------------------------------------------------------------------
// argueReact — the "are you kidding me" side
// ---------------------------------------------------------------------------
// Both arms thrown up and out, twice a cycle, offset a quarter cycle from the
// pointer's jabs (0.40/0.85 against argue's 0.15/0.65) so the two read as
// call-and-response rather than two loops that happen to share a floor.
function handsUpRight(k) {
  return {
    RightShoulder: [0, mix(2, -6, k), mix(2, -16, k)],
    RightArm:      [mix(-4, -80, k), mix(8, 26, k), mix(99, -18, k)],
    RightForeArm:  [0, mix(16, 46, k), 0],
    RightHand:     [mix(5, -8, k), mix(4, 10, k), 0],
    RightPalm:     [mix(1, -0.18, k), mix(-0.05, 0.80, k), mix(-0.32, 0.42, k)],
  }
}

function handsUp(k) {
  const r = handsUpRight(k)
  return pose(r, ANIM.mirrorPose(r))
}

function argueReactPose(t) {
  const up1 = bump(t, 0.40, 0.26)
  const up2 = bump(t, 0.85, 0.26)
  const k = Math.max(up1, up2)
  const lean = 6 + 5 * k
  const nod = -5 * k + 2 * sin(t, 5) * k    // a little head-shake right at the peak
  return pose(ANIM.STANDING,
    torso(lean, 0, nod),
    { hips: [0, 0, 0] },
    handsUp(k))
}

// ---------------------------------------------------------------------------
// The clip specs, in the {fn, dur, keys, loop} shape anim.js's own CLIPS
// table uses. Both share ARGUE_DUR — that's what keeps them in phase forever
// once they're started on the same frame; two loops of different length would
// drift apart within a few cycles.
// ---------------------------------------------------------------------------
export const ARGUE_DUR = 2.4
// 30 keys over 2.4s is a sample every 80ms. The fastest thing in either pose
// is a bump() of width 0.30 (0.72s edge-to-edge) with zero-slope ends, so
// that's comfortably enough to not facet the jab/throw.
const ARGUE_KEYS = 30

const ARGUE_SPEC = { fn: arguePose, dur: ARGUE_DUR, keys: ARGUE_KEYS, loop: true }
const ARGUE_REACT_SPEC = { fn: argueReactPose, dur: ARGUE_DUR, keys: ARGUE_KEYS, loop: true }

/** Registry an integrator can fold straight into anim.js's own CLIPS table
 *  (`Object.assign(CLIPS, registry)` or a spread) — this file never touches
 *  anim.js itself. */
export const registry = { argue: ARGUE_SPEC, argueReact: ARGUE_REACT_SPEC }

// ---------------------------------------------------------------------------
// Scratch rig, real hierarchy this time (not a flat bag) — measuring toe
// height and loop seam needs actual world-space matrices, which only exist
// if the bones are really parented. Topology from anim.js's own header
// comment ("Spine chain is INVERTED: Hips > Spine02 > Spine01 > Spine > neck
// > Head") plus the bone list in BIND.
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

/** Build a THREE.AnimationClip from a {fn, dur, keys, loop} spec. */
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

const _clips = {}
/** Build (and memoise) one of this module's clips: 'argue' or 'argueReact'. */
export function getClip(name) {
  if (!registry[name]) throw new Error(`argue: no clip "${name}". Have: ${Object.keys(registry).join(', ')}`)
  if (!_clips[name]) _clips[name] = buildClipFromSpec(name, registry[name])
  return _clips[name]
}

// ---------------------------------------------------------------------------
// Spacing and marks
// ---------------------------------------------------------------------------
// Not a contact action, so there's no measured CONTACT_Z_CM to derive this
// from — it's chosen directly, as a root-to-root distance for a
// CHARACTER_HEIGHT character. Close enough to read as confrontational,
// clear enough that neither arm's reach comes near the other person: the
// point/throw poses above keep the working hand within about 30cm of the
// character's own centreline (see measureReach below), so two of those,
// even nose to nose, use up 60cm — this leaves real air on top of that.
export const ARGUE_SPACING = 0.85

export function spacingFor(height = CHARACTER_HEIGHT) {
  return ARGUE_SPACING * (height / CHARACTER_HEIGHT)
}

/** Where the pair have to stand — highfive.js's marks function already takes
 *  spacing as a plain argument, so there's nothing paired-action-specific
 *  left to write here; just feed it this action's own number. */
export function argueMarks(aPos, bPos, spacing = ARGUE_SPACING) {
  return highfiveMarks(aPos, bPos, spacing)
}

// ---------------------------------------------------------------------------
// The pair routine: walk -> settle -> argue (loops until told to stop).
// Same shape as highfiveRoutine, except the last phase never ends on its
// own — this is meant to sit under a beat of arbitrary length, not resolve.
// ---------------------------------------------------------------------------
const shortestAngle = d => ((d % TAU) + TAU + Math.PI) % TAU - Math.PI

function turn(g, yaw, max) {
  const d = shortestAngle(yaw - g.rotation.y)
  if (Math.abs(d) <= max) { g.rotation.y = yaw; return true }
  g.rotation.y += Math.sign(d) * max
  return false
}

/** Start a clip built by this module on `root`, crossfading from whatever's
 *  currently playing. Not registered in anim.js, so ANIM.crossfade doesn't
 *  know its name — this does the same thing by hand, on the same per-object
 *  mixer ANIM.getMixer caches. */
function playLocal(root, name, fade) {
  const mixer = ANIM.getMixer(root)
  const clip = getClip(name)
  const action = mixer.clipAction(clip)
  action.setLoop(THREE.LoopRepeat, Infinity)
  action.reset()
  action.enabled = true
  action.setEffectiveWeight(1)
  const prevName = ANIM.currentClip(root)
  if (prevName) action.crossFadeFrom(ANIM.makeAction(root, prevName), fade, false)
  action.play()
  return action
}

// Walk-phase leg-to-mark delta, reused across legs and frames — see
// handshake.js's _ab. Each leg's use starts and ends within one loop
// iteration below, so there's no aliasing between legs or frames.
const _d = new THREE.Vector3()

/**
 * @param {{group:THREE.Object3D, root:THREE.Object3D, height:number}} a  gets the `argue` (pointer) role
 * @param {{group:THREE.Object3D, root:THREE.Object3D, height:number}} b  gets the `argueReact` (hands-up) role
 */
export function argueRoutine(a, b, {
  speed = 1.15,
  turnRate = 5.0,
  settle = 0.28,
  arriveEps = 0.006,
  height = CHARACTER_HEIGHT,
} = {}) {
  const spacing = spacingFor(height)
  const marks = argueMarks(a.group.position, b.group.position, spacing)
  const legs = [
    { c: a, mark: marks.a, arrived: false, clip: 'argue' },
    { c: b, mark: marks.b, arrived: false, clip: 'argueReact' },
  ]
  let phase = 'walk', clock = 0

  for (const l of legs) ANIM.crossfade(l.c.root, 'walk', 0.2, { timeScale: walkScale(speed, height) })

  function step(dt) {
    if (phase === 'walk') {
      let all = true
      for (const l of legs) {
        const g = l.c.group
        const d = _d.subVectors(l.mark.pos, g.position); d.y = 0
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
        // Same frame, both of them. This is the whole sync story — see
        // highfive.js. Loops are timed off wall clock (not clip length), so
        // starting both actions at time=0 on the same tick is all it takes
        // for arguePose/argueReactPose's own phase offsets to stay meaningful.
        for (const l of legs) {
          const act = playLocal(l.c.root, l.clip, 0.16)
          act.time = 0
        }
        phase = 'argue'; clock = 0
      }
    } else if (phase === 'argue') {
      clock += dt   // runs until stop() is called; nothing here ends it
    }
    for (const l of legs) ANIM.update(l.c.root, dt)
    return phase
  }

  /** Fade both characters back to idle. Call whenever the beat this was
   *  covering resolves. */
  function stop(fade = 0.3) {
    for (const l of legs) ANIM.crossfade(l.c.root, 'idle', fade)
    phase = 'done'
  }

  return { step, stop, marks, spacing, get phase() { return phase } }
}

// ---------------------------------------------------------------------------
// Measurement
// ---------------------------------------------------------------------------

/** World position of a bone on the scratch rig at a given clip/t, for
 *  no-touch and floor checks. Character-space (armature cm), not world
 *  metres — same convention as highfive.js's palmPoint before its height
 *  scale is applied. */
export function boneAt(clipName, t, boneName) {
  const rig = makeRig()
  ANIM.applyPose(rig.Hips, registry[clipName].fn(t))
  const b = rig[boneName]
  b.updateWorldMatrix(true, false)
  return new THREE.Vector3().setFromMatrixPosition(b.matrixWorld)
}
