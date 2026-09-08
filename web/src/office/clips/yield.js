// Yield: rung 1, one agent reads while another edits. Not a confrontation —
// the reader notices the editor is already in there and gets out of the way.
// Two different, small gestures, phase-matched, same shape argue.js uses for
// its asymmetric pair:
//
//   yieldStep — the reader. Glances up, offers a quick open-palm "after you",
//     and settles back a half step. Reads the room, stands down.
//   yieldKeep — the editor. A brief nod, hands never really leave a typing
//     posture. Barely breaks stride, because from their side nothing happened.
//
// Both are deliberately SMALLER than highfive/handshake/argue. This is a
// beat, not a routine — a rung-1 read-vs-edit is the mildest thing on the
// ladder, so the animation should read as a half-second aside, not a scene.
// Neither role touches the other, so there's no measured contact geometry;
// the marks distance is chosen directly, same reasoning as argue.js's
// ARGUE_SPACING — close enough to read as "aware of each other," far enough
// that the open-palm reach doesn't come near the editor.
//
// WHY THIS FILE BUILDS ITS OWN CLIPS
// Same story as handshake.js/argue.js: anim.js exports applyPose (already
// running the palm-roll solve) but not the internals that turn a pose
// function into an AnimationClip. So this file builds a scratch rig from
// anim.js's own BIND data and replays applyPose across it, same as those two.
//
// No IK. Marks are the primitive; the controller owns the pathing.

import * as THREE from 'three'
import * as ANIM from '../anim.js'
import { highfiveMarks, yawTowards, walkScale, CHARACTER_HEIGHT } from '../highfive.js'

const TAU = Math.PI * 2
const wrap = p => ((p % 1) + 1) % 1
const mix = (a, b, t) => a + (b - a) * t

/** Periodic raised cosine — anim.js's own `bump`, reimplemented here for the
 *  same reason argue.js does: it's three lines, not worth reaching into
 *  anim.js's private scope for. 1 at centre, 0 outside width, zero slope at
 *  the edges. */
function bump(p, centre, width) {
  const d = wrap(p - centre + 0.5) - 0.5
  const h = width * 0.5
  if (Math.abs(d) >= h) return 0
  return 0.5 * (1 + Math.cos(Math.PI * d / h))
}

function pose(...parts) {
  const o = {}
  for (const p of parts) if (p) for (const k in p) o[k] = p[k]
  return o
}

// ---------------------------------------------------------------------------
// Timing — glance, offer, weight shift, nod
// ---------------------------------------------------------------------------
// A factory, not four bare bump() calls, so the -test.html harness (and this
// file) can hold more than one timed take on the same beat side by side —
// see EMPHATIC_TIMING below. The motion pass this config exists to fix (see
// STATE.md, round 2 task 4's own words: "a first draft off the pose math
// alone, not off how it actually reads"):
//
//   1. the reader's glance-up has to visibly PRECEDE the open-palm offer
//      (anticipation) — lookPeak sits well before armPeak, and lookWidth is
//      narrow enough that the glance has mostly resolved before the arm
//      starts moving, not just technically-first.
//   2. the backward weight shift needs to actually read — stepAmp/
//      hipsLiftAmp bumped up from the first-draft values.
//   3. the editor's nod has to land AFTER the offer, not simultaneously —
//      nodPeak sits comfortably past armPeak, not just a few percent later.
const DEFAULT_TIMING = {
  dur: 1.7,
  lookPeak: 0.20, lookWidth: 0.30,   // reader's glance up — first
  armPeak: 0.50,  armWidth: 0.50,    // reader's open-palm offer — after the glance
  stepAmp: 3.6,   hipsLiftAmp: 5.5,  // reader's backward weight shift, rides the offer
  nodPeak: 0.64,  nodWidth: 0.34,    // editor's nod — after the offer, not with it
}

// Alternate take: a longer beat, a bigger step back, a nod that waits even
// longer before landing. Doubletake's variants (see doubletake.js) are
// "longer pause" and "bigger shrug"; this clip has no discrete pause to
// stretch, so its analogue is "everything a little more deliberate."
// Exposed through `variants.emphatic` for side-by-side comparison in
// yield-test.html — not wired into World.
const EMPHATIC_TIMING = {
  dur: 2.1,
  lookPeak: 0.17, lookWidth: 0.26,
  armPeak: 0.46,  armWidth: 0.44,
  stepAmp: 6.0,   hipsLiftAmp: 8.5,
  nodPeak: 0.70,  nodWidth: 0.28,
}

export { DEFAULT_TIMING, EMPHATIC_TIMING }

// ---------------------------------------------------------------------------
// yieldStep — the reader stands down
// ---------------------------------------------------------------------------
// One beat: look up (lookUp rises first), open-palm offer at chest height
// (k rises after), settle back a half step (a small backward hip offset,
// same "weight shift, not real footwork" convention argue.js's `hips` uses
// — a real step belongs to the controller's marks/pathing, not a static
// clip). Both ease 0 -> 1 -> 0 across the whole clip so it starts and ends
// at rest.

function yieldStepArm(k) {
  return {
    RightShoulder: [0, mix(2, -4, k), mix(2, 16, k)],
    RightArm:      [mix(-4, -58, k), mix(8, 12, k), mix(99, 30, k)],
    RightForeArm:  [0, mix(16, 62, k), 0],
    RightHand:     [mix(5, -6, k), mix(4, 2, k), 0],
    // Palm out and slightly up: an offer, not a push. Solved target, not a
    // hand-picked roll — see anim.js's PALM AIMING note.
    RightPalm:     [mix(1, 0.05, k), mix(-0.05, 0.55, k), mix(-0.32, 0.55, k)],
  }
}

function yieldStepPose(t, timing = DEFAULT_TIMING) {
  const { lookPeak, lookWidth, armPeak, armWidth, stepAmp, hipsLiftAmp } = timing
  const k = bump(t, armPeak, armWidth)
  const lookUp = bump(t, lookPeak, lookWidth)
  return pose(ANIM.STANDING,
    { hips: [0, 0, -stepAmp * k] },   // half step back, read as a weight shift
    { Hips: [0, hipsLiftAmp * k, 0] },
    {
      Spine02: [-2 * lookUp, -3 * k, 0],
      Spine01: [-1 * lookUp, -2 * k, 0],
      neck:    [-8 * lookUp, -4 * k, 0],
      Head:    [-14 * lookUp, -6 * k, 2 * lookUp],
    },
    yieldStepArm(k),
    // off arm barely moves — this is a one-arm gesture, not a full turn
    { LeftArm: [-4, -8, -99 + 3 * k], LeftForeArm: [0, -16 - 6 * k, 0] })
}

// ---------------------------------------------------------------------------
// yieldKeep — the editor barely looks up
// ---------------------------------------------------------------------------
// Hands stay in a typing-adjacent posture throughout (forward, low, close to
// the body — approximating anim.js's own `type` clip without reaching into
// it) while just the head/neck carries a short nod, timed to land after the
// reader's offer has already landed — an acknowledgment, not a reflex.

const KEEP_ARMS = {
  LeftArm:  [-38, -6, -60], RightArm:  [-38, 6, 60],
  LeftForeArm: [0, -70, 0], RightForeArm: [0, 70, 0],
  LeftHand: [10, -4, 0],    RightHand: [10, 4, 0],
  LeftPalm: [0.1, -0.9, -0.4], RightPalm: [0.1, 0.9, -0.4],
}

function yieldKeepPose(t, timing = DEFAULT_TIMING) {
  const { nodPeak, nodWidth } = timing
  const nod = bump(t, nodPeak, nodWidth)
  return pose(ANIM.STANDING, KEEP_ARMS,
    {
      Spine02: [1 * nod, 0, 0],
      neck:    [6 * nod, 0, 0],
      Head:    [10 * nod, 0, 0],
    })
}

// ---------------------------------------------------------------------------
// Clip specs
// ---------------------------------------------------------------------------
export const YIELD_DUR = DEFAULT_TIMING.dur
// One-shot, so keys just need to resolve three bump()s cleanly — none of
// them are a fast snap (that's doubletake's problem, see doubletake.js), so
// a flat sample rate is fine. 24 samples over 1.7s is ~70ms/sample.
const YIELD_KEYS = 24

const YIELD_STEP_SPEC = { fn: t => yieldStepPose(t, DEFAULT_TIMING), dur: YIELD_DUR, keys: YIELD_KEYS, loop: false }
const YIELD_KEEP_SPEC = { fn: t => yieldKeepPose(t, DEFAULT_TIMING), dur: YIELD_DUR, keys: YIELD_KEYS, loop: false }

/** Registry in the shape anim.js's own CLIPS table takes, folded in below.
 *  This is the picked take — the only one World ever sees. */
export const registry = { yieldStep: YIELD_STEP_SPEC, yieldKeep: YIELD_KEEP_SPEC }

// Alternate timing, same key count, longer duration. Compare against
// `registry` in yield-test.html's variant picker; not folded into
// ANIM.CLIPS, not reachable from World.
const YIELD_STEP_SPEC_EMPHATIC = { fn: t => yieldStepPose(t, EMPHATIC_TIMING), dur: EMPHATIC_TIMING.dur, keys: 30, loop: false }
const YIELD_KEEP_SPEC_EMPHATIC = { fn: t => yieldKeepPose(t, EMPHATIC_TIMING), dur: EMPHATIC_TIMING.dur, keys: 30, loop: false }

export const variants = {
  default: registry,
  emphatic: { yieldStep: YIELD_STEP_SPEC_EMPHATIC, yieldKeep: YIELD_KEEP_SPEC_EMPHATIC },
}

// Folded into anim.js's own CLIPS table at import time, so these play by name
// through ANIM.crossfade like every other clip — one clip table, one owner of
// the mixer's weights. See anim.js's CLIPS header for the timing rule (the
// merge has to happen before the first createClips(), which import time is).
Object.assign(ANIM.CLIPS, registry)

// The alternate takes fold in too, under `<clip><Variant>` — derived from the
// variant key, not a second hand-kept table. yield-test.html's picker
// plays them by those names; nothing else ever asks for them.
for (const [key, reg] of Object.entries(variants)) {
  if (key === 'default') continue
  const suffix = key[0].toUpperCase() + key.slice(1)
  for (const [name, spec] of Object.entries(reg)) ANIM.CLIPS[name + suffix] = spec
}


// ---------------------------------------------------------------------------
// Spacing and marks
// ---------------------------------------------------------------------------
// Not a contact action — chosen directly, same reasoning as ARGUE_SPACING.
// Tighter than argue's 0.85m: this is proximity, not confrontation, and
// yieldStepPose's reach never leaves the reader's own half of the gap.
export const YIELD_SPACING = 0.62

export function spacingFor(height = CHARACTER_HEIGHT) {
  return YIELD_SPACING * (height / CHARACTER_HEIGHT)
}

/** Where the pair have to stand — highfiveMarks already takes spacing as a
 *  plain argument, so this action needs nothing more specific than that. */
export function yieldMarks(aPos, bPos, spacing = YIELD_SPACING) {
  return highfiveMarks(aPos, bPos, spacing)
}

// ---------------------------------------------------------------------------
// The pair routine — walk -> settle -> beat -> done. Shorter tail than
// argue.js's (this resolves on its own; it isn't sitting under an
// open-ended contest) and shaped like handshakeRoutine's one-shot ending.
// ---------------------------------------------------------------------------
const shortestAngle = d => ((d % TAU) + TAU + Math.PI) % TAU - Math.PI

function turn(g, yaw, max) {
  const d = shortestAngle(yaw - g.rotation.y)
  if (Math.abs(d) <= max) { g.rotation.y = yaw; return true }
  g.rotation.y += Math.sign(d) * max
  return false
}


// Walk-phase leg-to-mark delta, reused across legs and frames — see
// handshake.js's _ab. Each leg's use starts and ends within one loop
// iteration below, so there's no aliasing between legs or frames.
const _d = new THREE.Vector3()

/**
 * @param {{group:THREE.Object3D, root:THREE.Object3D, height:number}} a  gets 'yieldStep' (the reader)
 * @param {{group:THREE.Object3D, root:THREE.Object3D, height:number}} b  gets 'yieldKeep' (the editor)
 */
export function yieldRoutine(a, b, {
  speed = 1.15,
  turnRate = 5.0,
  settle = 0.20,
  arriveEps = 0.006,
  height = CHARACTER_HEIGHT,
} = {}) {
  const spacing = spacingFor(height)
  const marks = yieldMarks(a.group.position, b.group.position, spacing)
  const legs = [
    { c: a, mark: marks.a, arrived: false, clip: 'yieldStep' },
    { c: b, mark: marks.b, arrived: false, clip: 'yieldKeep' },
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
          ANIM.crossfade(l.c.root, 'idle', 0.2)
        }
        if (l.arrived && !turn(g, l.mark.yaw, turnRate * dt)) all = false
      }
      if (all) { phase = 'settle'; clock = 0 }
    } else if (phase === 'settle') {
      clock += dt
      if (clock >= settle) {
        for (const l of legs) ANIM.crossfade(l.c.root, l.clip, 0.14)
        phase = 'beat'; clock = 0
      }
    } else if (phase === 'beat') {
      clock += dt
      if (clock >= YIELD_DUR) phase = 'done'
    }
    for (const l of legs) ANIM.update(l.c.root, dt)
    return phase
  }

  return { step, marks, spacing, get phase() { return phase } }
}
