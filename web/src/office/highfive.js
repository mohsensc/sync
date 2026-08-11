// Choreographed high five: marks, not IK.
//
// The contact problem is only hard if you let the two characters stand wherever
// they happen to be and then try to bend an arm until the hands meet. They do
// not have to. The controller owns the pathing, so the spacing is an input we
// pick, not a constraint handed to us: walk both characters onto exact marks,
// then play a clip authored for precisely that distance. Hit your mark, play
// the canned action. Deterministic, free per frame, and the clip gets to be
// tuned for how it LOOKS rather than merely for whether it touches.
//
// Two facts make it work:
//
//   1. anim.js's highfive clip puts the palm centre on the character's OWN
//      midline (local x = 0) at a fixed forward reach. Two characters facing
//      each other across 2x that reach therefore put their palms at the same
//      world point, exactly, whatever their world positions and yaws are.
//
//   2. Both play the SAME clip. They are already mirrored — by facing each
//      other. Each raises its right hand; because they are 180 degrees apart,
//      those are on opposite sides in world space, and each reaches across its
//      own centreline to meet in the middle, which is what a real high five is.
//      Playing anim.js's mirrored clip on the partner would give a right-to-
//      left slap, hands meeting off to one side. That is not this.
//
// No IK anywhere. See the note at the bottom of the office README.

import * as THREE from 'three'
import * as ANIM from './anim.js'

// ---------------------------------------------------------------------------
// The spacing the clip is authored for
// ---------------------------------------------------------------------------
// Contact geometry lives in the rig, so it scales with the character. These are
// in the GLB's own units (armature centimetres, see anim.js) and get turned
// into metres by whatever height the character is placed at.

/** Height anim.js's numbers and HIGHFIVE_SPACING below are quoted at. */
export const CHARACTER_HEIGHT = 1.68

/** Bind-pose height of character.glb, armature cm. Measured off the mesh. */
export const MODEL_HEIGHT_CM = 170.0

/** Forward reach of the palm centre at the contact frame, armature cm. Comes
 *  straight from the clip so the two can never drift apart. */
export const CONTACT_Z_CM = ANIM.HIGHFIVE_CONTACT_Z_CM

/** Root-to-root distance at contact, as a fraction of character height. */
export const HIGHFIVE_SPACING_RATIO = (2 * CONTACT_Z_CM) / MODEL_HEIGHT_CM

/** Root-to-root distance at contact, metres, for a CHARACTER_HEIGHT character.
 *  Currently 0.908 m: about right for two adults squaring up to greet. */
export const HIGHFIVE_SPACING = HIGHFIVE_SPACING_RATIO * CHARACTER_HEIGHT

/** Fraction of the clip at which the palms are in contact. */
export const CONTACT_T = ANIM.HIGHFIVE_CONTACT_T

export function spacingFor(height = CHARACTER_HEIGHT) {
  return HIGHFIVE_SPACING_RATIO * height
}

// ---------------------------------------------------------------------------
// Marks
// ---------------------------------------------------------------------------
const _ab = new THREE.Vector3()
const _mid = new THREE.Vector3()

/** Yaw that points a character's +Z at `dir` (a direction in world space). */
export function yawTowards(dir) { return Math.atan2(dir.x, dir.z) }

/**
 * Where the pair have to stand. Both marks sit on the line joining them,
 * `spacing` apart, centred on their midpoint, each facing the other. Whoever is
 * already closer to their mark walks less; nobody has to cross the other.
 *
 * @param {THREE.Vector3|number[]} aPos  character A's current position
 * @param {THREE.Vector3|number[]} bPos  character B's current position
 * @returns {{a:{pos:THREE.Vector3,yaw:number}, b:{pos:THREE.Vector3,yaw:number}, spacing:number}}
 */
export function highfiveMarks(aPos, bPos, spacing = HIGHFIVE_SPACING) {
  const a = toVec(aPos), b = toVec(bPos)
  _ab.subVectors(b, a)
  _ab.y = 0
  // Degenerate case: stacked on top of each other. Any axis will do, and
  // picking one keeps the function total rather than throwing at the caller.
  if (_ab.lengthSq() < 1e-8) _ab.set(0, 0, 1)
  _ab.normalize()
  _mid.addVectors(a, b).multiplyScalar(0.5)
  _mid.y = 0
  const half = spacing * 0.5
  const markA = _mid.clone().addScaledVector(_ab, -half)
  const markB = _mid.clone().addScaledVector(_ab, half)
  return {
    a: { pos: markA, yaw: yawTowards(_ab) },
    b: { pos: markB, yaw: yawTowards(_ab.clone().negate()) },
    spacing,
  }
}

function toVec(p) {
  return p && p.isVector3 ? p.clone() : new THREE.Vector3(p[0], p[1] ?? 0, p[2])
}

// ---------------------------------------------------------------------------
// The pair routine
// ---------------------------------------------------------------------------
// walk -> settle -> five. The pair advance together: nobody starts the five
// until both are on their mark and squared up, which is what keeps the two
// actions on the same frame. Starting them a frame apart is enough to turn a
// clean slap into a near miss, so the start is a single assignment for both.

const TAU = Math.PI * 2
const shortestAngle = d => ((d % TAU) + TAU + Math.PI) % TAU - Math.PI

/**
 * @param {{group:THREE.Object3D, root:THREE.Object3D, height:number}} a
 * @param {{group:THREE.Object3D, root:THREE.Object3D, height:number}} b
 */
export function highfiveRoutine(a, b, {
  speed = 1.15,          // m/s along the ground
  turnRate = 5.0,        // rad/s while squaring up
  settle = 0.28,         // seconds standing still before the five
  arriveEps = 0.006,     // metres
  height = CHARACTER_HEIGHT,
} = {}) {
  const spacing = spacingFor(height)
  const marks = highfiveMarks(a.group.position, b.group.position, spacing)
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
        // square up to the partner whether still walking or already parked
        if (l.arrived && !turn(g, l.mark.yaw, turnRate * dt)) all = false
      }
      if (all) { phase = 'settle'; clock = 0 }
    } else if (phase === 'settle') {
      clock += dt
      if (clock >= settle) {
        // Same frame, both of them. This is the whole sync story.
        for (const l of legs) {
          const act = ANIM.crossfade(l.c.root, 'highfive', 0.16)
          act.time = 0
        }
        phase = 'five'; clock = 0
      }
    } else if (phase === 'five') {
      clock += dt
      if (clock >= ANIM.getClip('highfive').duration) phase = 'done'
    }
    for (const l of legs) ANIM.update(l.c.root, dt)
    return phase
  }

  return {
    step,
    marks,
    spacing,
    get phase() { return phase },
    /** Seconds from the start of the five to the contact frame. */
    contactAt: ANIM.getClip('highfive').duration * CONTACT_T,
  }
}

/** Clip rate that keeps the feet planted at a given ground speed. */
export function walkScale(speed, height = CHARACTER_HEIGHT) {
  const perCycle = ANIM.WALK_CYCLE_METERS * (height / CHARACTER_HEIGHT)
  return speed * ANIM.getClip('walk').duration / perCycle
}

/** Rotate `g` toward `yaw`, at most `max` radians. True once it is there. */
function turn(g, yaw, max) {
  const d = shortestAngle(yaw - g.rotation.y)
  if (Math.abs(d) <= max) { g.rotation.y = yaw; return true }
  g.rotation.y += Math.sign(d) * max
  return false
}

// ---------------------------------------------------------------------------
// Measurement
// ---------------------------------------------------------------------------

/**
 * Where a hand's palm centre is in world space. The bone sits at the wrist, so
 * asserting on bone positions alone understates the contact: two palms flush
 * against each other leave their wrists PALM_OUT_CM apart on either side.
 */
const _p = new THREE.Vector3(), _q = new THREE.Quaternion(), _s = new THREE.Vector3()
const _up = new THREE.Vector3()

/** Palm centre along the hand bone, armature cm (hand runs 0.8 -> 21.3). */
export const PALM_ALONG_CM = 12.0
/** Palm surface off the bone axis, armature cm. */
export const PALM_OUT_CM = 3.5

export function palmPoint(root, side = 'Right', height = CHARACTER_HEIGHT) {
  const hand = root.getObjectByName(side + 'Hand')
  if (!hand) return null
  hand.updateWorldMatrix(true, false)
  hand.matrixWorld.decompose(_p, _q, _s)
  const k = (height / MODEL_HEIGHT_CM)      // armature cm -> world metres
  const out = _p.clone()
  out.addScaledVector(_up.set(0, 1, 0).applyQuaternion(_q), PALM_ALONG_CM * k)
  out.addScaledVector(ANIM.PALM_NORMAL[side + 'Hand'].clone().normalize().applyQuaternion(_q), PALM_OUT_CM * k)
  return out
}

export function handPoint(root, side = 'Right') {
  const hand = root.getObjectByName(side + 'Hand')
  if (!hand) return null
  hand.updateWorldMatrix(true, false)
  return new THREE.Vector3().setFromMatrixPosition(hand.matrixWorld)
}
