// Two-bone IK, and the high-five pair driver built on top of it.
//
// WHY THIS EXISTS
// The highfive clip in anim.js rotates the arm by fixed angles, so where the
// hand ends up depends entirely on how far apart the two characters happen to
// stand. The hands touch at one exact spacing and miss everywhere else. No
// amount of angle tuning fixes that.
//
// Instead: pick one shared contact point in world space, then solve each
// character's Arm + ForeArm so the Hand lands on it. Closed form — the elbow
// angle is the law of cosines, the shoulder aim is a look-at plus a pole vector
// that keeps the elbow swinging outward instead of through the ribs.
//
// It runs AFTER the mixer each frame, as a procedural pose on top of the baked
// clip, faded in over the approach and out over the recoil. The clip still owns
// the timing, the weight shift and the torso. The IK only owns where the hand
// goes.
//
// All of it is world space, so it survives whatever scale and yaw the
// character's group carries.

import * as THREE from 'three'

const UP = new THREE.Vector3(0, 1, 0)
const clamp = (v, a, b) => v < a ? a : v > b ? b : v
const smooth = x => { x = clamp(x, 0, 1); return x * x * (3 - 2 * x) }

/** Trapezoid envelope: 0 before a, 1 by b, held to c, 0 again by d. */
export function envelope(t, a, b, c, d) {
  if (t <= a || t >= d) return 0
  if (t < b) return smooth((t - a) / (b - a))
  if (t <= c) return 1
  return 1 - smooth((t - c) / (d - c))
}

// ---------------------------------------------------------------------------
// Writing a world-space rotation onto a bone
// ---------------------------------------------------------------------------
const _bw = new THREE.Quaternion()
const _tw = new THREE.Quaternion()
const _pw = new THREE.Quaternion()

/**
 * Compose `delta` (world space) onto `bone` and write it back as a local
 * quaternion. Slerping toward the solved rotation by w is what lets the IK fade
 * in and out without popping.
 */
export function rotateWorld(bone, delta, w = 1) {
  if (w <= 0) return
  bone.getWorldQuaternion(_bw)
  _tw.copy(delta).multiply(_bw)
  if (w < 1) { _bw.slerp(_tw, w); _tw.copy(_bw) }
  bone.parent.getWorldQuaternion(_pw)
  bone.quaternion.copy(_pw.invert()).multiply(_tw)
  bone.updateMatrixWorld(true)      // children need to see it before the next step
}

// ---------------------------------------------------------------------------
// Two-bone IK
// ---------------------------------------------------------------------------
const k = {
  A: new THREE.Vector3(), E: new THREE.Vector3(), H: new THREE.Vector3(),
  toT: new THREE.Vector3(), dir: new THREE.Vector3(), pole: new THREE.Vector3(),
  axis: new THREE.Vector3(), bend: new THREE.Vector3(), cur: new THREE.Vector3(),
  q: new THREE.Quaternion(),
}

/**
 * Solve `upper` and `lower` so `end` reaches `target`. upper/lower/end are the
 * shoulder, elbow and wrist bones. `pole` is a world point the elbow is pulled
 * toward.
 *
 * Returns { reach, want, max }; reach < 1 means the target is further off than
 * the arm is long, and the arm ends up straight and pointing at it.
 *
 * Swing only, never twist, so whatever roll the clip authored survives.
 */
export function solveTwoBone(upper, lower, end, target, pole, w = 1) {
  upper.getWorldPosition(k.A)
  lower.getWorldPosition(k.E)
  end.getWorldPosition(k.H)

  const L1 = k.A.distanceTo(k.E)
  const L2 = k.E.distanceTo(k.H)
  k.toT.copy(target).sub(k.A)
  const want = k.toT.length()
  if (want < 1e-6 || L1 < 1e-6 || L2 < 1e-6) return { reach: 0, want, max: L1 + L2 }

  const dMax = (L1 + L2) * 0.9995         // never dead straight, acos gets touchy
  const dMin = Math.abs(L1 - L2) + 1e-4
  const d = clamp(want, dMin, dMax)
  k.dir.copy(k.toT).divideScalar(want)

  // Elbow angle, law of cosines.
  const alpha = Math.acos(clamp((L1 * L1 + d * d - L2 * L2) / (2 * L1 * d), -1, 1))

  // Pole, projected perpendicular to the aim so it only picks which way the
  // elbow swings and never moves where the hand lands.
  k.pole.copy(pole).sub(k.A)
  k.pole.addScaledVector(k.dir, -k.pole.dot(k.dir))
  if (k.pole.lengthSq() < 1e-9) {
    k.pole.copy(UP).addScaledVector(k.dir, -k.dir.y)
    if (k.pole.lengthSq() < 1e-9) k.pole.set(1, 0, 0)
  }
  k.pole.normalize()

  // Turning dir by +alpha about (dir x pole) tips it onto the pole side.
  k.axis.copy(k.dir).cross(k.pole).normalize()
  k.bend.copy(k.dir).applyQuaternion(k.q.setFromAxisAngle(k.axis, alpha))

  // 1. swing the upper bone so the elbow lands on the solved cone
  k.cur.copy(k.E).sub(k.A).normalize()
  rotateWorld(upper, k.q.setFromUnitVectors(k.cur, k.bend), w)

  // 2. swing the lower bone onto the target. |target - elbow| is already L2 by
  //    construction, so this closes the chain exactly.
  lower.getWorldPosition(k.E)
  end.getWorldPosition(k.H)
  k.cur.copy(k.H).sub(k.E).normalize()
  k.dir.copy(target).sub(k.E).normalize()
  rotateWorld(lower, k.q.setFromUnitVectors(k.cur, k.dir), w)

  return { reach: Math.min(1, dMax / want), want, max: L1 + L2 }
}

const m = { cur: new THREE.Vector3(), dir: new THREE.Vector3(), q: new THREE.Quaternion() }

/** Point a bone's local +Y — the way its children run — along dirWorld. */
export function aimBone(bone, dirWorld, w = 1) {
  if (w <= 0) return
  bone.getWorldQuaternion(_bw)
  m.cur.set(0, 1, 0).applyQuaternion(_bw)
  m.dir.copy(dirWorld).normalize()
  rotateWorld(bone, m.q.setFromUnitVectors(m.cur, m.dir), w)
}

// ---------------------------------------------------------------------------
// High five
// ---------------------------------------------------------------------------
const shortestAngle = a => Math.atan2(Math.sin(a), Math.cos(a))
const IDENT = new THREE.Quaternion()

export const HIGHFIVE_DEFAULTS = {
  // Which hand each of the two swings. 'same' means both use `hand`, which when
  // they face each other is the one on the OPPOSITE side in world space, so both
  // reach across their own midline and meet on the centre line — a real
  // right-to-right five. 'mirror' gives the partner the other hand, so the two
  // hands are already across from each other and contact happens off to one
  // side, clear of the faces.
  hand: 'Right',
  pairing: 'same',
  lift: 0.22,          // contact height above the midpoint of the two shoulders
  palmGap: 0.05,       // wrist-to-wrist separation at contact, metres
  clavicle: 0.45,      // how much of the reach the collarbone takes on
  lean: 12 * Math.PI / 180,
  maxStep: 0.9,        // how far a character may close the gap on its own
  turnWin:     [0.00, 0.30, 0.84, 1.00],
  approachWin: [0.02, 0.42, 0.60, 0.95],
  ikWin:       [0.16, 0.44, 0.58, 0.88],
}

/**
 * Driver for one pair. `a` and `b` are { group, root } — group is the placed and
 * scaled parent, root the skinned character under it.
 *
 * Every frame: hf.restore(), advance the mixer, hf.update(t). Contact is at
 * t = 0.5. Base transforms are captured now, so rebuild if you move them.
 */
export function highFive(a, b, opts = {}) {
  const o = Object.assign({}, HIGHFIVE_DEFAULTS, opts)
  const other = s => s === 'Right' ? 'Left' : 'Right'
  const sides = o.pairing === 'mirror' ? [o.hand, other(o.hand)] : [o.hand, o.hand]

  const rig = (c, side) => ({
    group: c.group, root: c.root, side,
    out:  side === 'Right' ? -1 : 1,       // which way the elbow should hang
    clav: c.root.getObjectByName(side + 'Shoulder'),
    arm:  c.root.getObjectByName(side + 'Arm'),
    fore: c.root.getObjectByName(side + 'ForeArm'),
    hand: c.root.getObjectByName(side + 'Hand'),
    s02:  c.root.getObjectByName('Spine02'),
    s01:  c.root.getObjectByName('Spine01'),
    sp:   c.root.getObjectByName('Spine'),
  })
  const R = [rig(a, sides[0]), rig(b, sides[1])]
  const base = R.map(r => ({ yaw: r.group.rotation.y, pos: r.group.position.clone() }))

  // Every bone this driver writes to, so it can put them back. three's
  // PropertyMixer skips writing a track whose sampled value has not changed
  // since the last apply, so a held or scrubbed clip leaves our edits in place
  // and the next frame stacks another delta on top. Two frames of that and the
  // torso is folded in half. It is also how the solve gets iterated below.
  const driven = R.map(r => {
    const bones = [r.s02, r.s01, r.sp, r.clav, r.arm, r.fore, r.hand]
    return { bones, q: bones.map(() => new THREE.Quaternion()), valid: false }
  })
  function save() {
    for (const d of driven) {
      for (let i = 0; i < d.bones.length; i++) d.q[i].copy(d.bones[i].quaternion)
      d.valid = true
    }
  }
  function putBack() {
    for (const d of driven) {
      if (!d.valid) continue
      for (let i = 0; i < d.bones.length; i++) d.bones[i].quaternion.copy(d.q[i])
      d.bones[0].parent.updateMatrixWorld(true)
    }
  }

  const contact = new THREE.Vector3()
  const state = { t: 0, ik: 0, gap: 0, step: 0, residual: 0, sep: 0, iters: 0 }

  const s = {
    sa: new THREE.Vector3(), sb: new THREE.Vector3(), fwd: new THREE.Vector3(),
    v: new THREE.Vector3(), out: new THREE.Vector3(), pole: new THREE.Vector3(),
    p: new THREE.Vector3(), tip: new THREE.Vector3(),
    tgt: [new THREE.Vector3(), new THREE.Vector3()],
    q: new THREE.Quaternion(), q2: new THREE.Quaternion(),
  }

  /** Yaw both to face each other and slide them `step` closer, scaled by f. */
  function place(fTurn, fApp, step) {
    for (let i = 0; i < 2; i++) {
      const g = R[i].group
      s.v.copy(base[1 - i].pos).sub(base[i].pos); s.v.y = 0
      if (s.v.lengthSq() < 1e-9) continue
      const aim = Math.atan2(s.v.x, s.v.z)     // yaw that points local +Z at them
      g.rotation.y = base[i].yaw + shortestAngle(aim - base[i].yaw) * fTurn
      s.v.normalize()
      g.position.copy(base[i].pos).addScaledVector(s.v, step * fApp)
      g.updateMatrixWorld(true)
    }
  }

  /** Fold the torso toward dir. A third each, and the deltas stack down the
   *  chain, so the chest ends up with the whole angle and it reads as a spine
   *  rather than a hinge. */
  function lean(r, dir, angle) {
    if (angle <= 1e-4) return
    s.out.copy(UP).cross(dir)
    if (s.out.lengthSq() < 1e-9) return
    s.q.setFromAxisAngle(s.out.normalize(), angle / 3)
    rotateWorld(r.s02, s.q, 1)
    rotateWorld(r.s01, s.q, 1)
    rotateWorld(r.sp, s.q, 1)
  }

  /** Shared contact point: midway between the two acting shoulders, lifted. */
  function findContact() {
    R[0].arm.getWorldPosition(s.sa)
    R[1].arm.getWorldPosition(s.sb)
    state.sep = s.sa.distanceTo(s.sb)
    contact.copy(s.sa).add(s.sb).multiplyScalar(0.5).addScaledVector(UP, o.lift)
  }

  function solveArm(r, target, w) {
    // Collarbone first. Swinging it a fraction of the way toward the target is
    // what a real shoulder does when you reach high, and on this rig — stubby
    // arms, big head — it is the difference between touching and flailing.
    if (o.clavicle > 0) {
      r.clav.getWorldPosition(s.p)
      r.arm.getWorldPosition(s.tip)
      s.v.copy(s.tip).sub(s.p).normalize()
      s.out.copy(target).sub(s.p).normalize()
      s.q.setFromUnitVectors(s.v, s.out)
      s.q2.copy(IDENT).slerp(s.q, o.clavicle)
      rotateWorld(r.clav, s.q2, w)
    }
    // Pole below the shoulder, out to the acting side and a touch behind, so the
    // elbow hangs outward instead of clipping the ribs.
    r.arm.getWorldPosition(s.pole)
    r.group.getWorldQuaternion(s.q)
    s.out.set(r.out, 0, -0.35).applyQuaternion(s.q).normalize()
    s.pole.addScaledVector(s.out, 0.5).addScaledVector(UP, -0.6)
    return solveTwoBone(r.arm, r.fore, r.hand, target, s.pole, w)
  }

  /** Contact point, and the point each wrist actually aims at — half a palm gap
   *  short of it, so the palms meet instead of passing through each other. */
  function targets() {
    findContact()
    const half = o.palmGap * 0.5
    s.tgt[0].copy(contact).addScaledVector(s.fwd, -half)
    s.tgt[1].copy(contact).addScaledVector(s.fwd, half)
  }

  /** How far short of its target each wrist ended up. */
  function residual() {
    let worst = 0
    for (let i = 0; i < 2; i++) {
      R[i].hand.getWorldPosition(s.p)
      worst = Math.max(worst, s.p.distanceTo(s.tgt[i]))
    }
    return worst
  }

  return {
    contact, state, base, opts: o, sides,

    /**
     * Undo the last frame's procedural pose. CALL THIS BEFORE YOU ADVANCE THE
     * MIXER — see the note on `driven`. Harmless if the mixer does write, since
     * it only puts back the pose the mixer wrote last frame.
     */
    restore: putBack,

    /** t is the clip phase in [0,1]. Contact lands at 0.5. */
    update(t) {
      save()
      state.t = t
      const fTurn = envelope(t, ...o.turnWin)
      const fApp = envelope(t, ...o.approachWin)
      const fIK = envelope(t, ...o.ikWin)
      state.ik = fIK

      s.fwd.copy(base[1].pos).sub(base[0].pos); s.fwd.y = 0; s.fwd.normalize()

      // How far apart they can be and still touch depends on the lean, the
      // collarbone and the elbow, none of which have a tidy closed form. So
      // solve it for real, measure what is left over, step in by that, repeat.
      // Four passes is plenty; usually one or two.
      let step = 0, res = 0, it = 0
      for (; it < 4; it++) {
        putBack()
        place(1, 1, step)
        lean(R[0], s.fwd, o.lean)
        lean(R[1], s.v.copy(s.fwd).negate(), o.lean)
        targets()
        solveArm(R[0], s.tgt[0], 1)
        solveArm(R[1], s.tgt[1], 1)
        res = residual()
        if (res < 0.004 || step >= o.maxStep) break
        step = Math.min(o.maxStep, step + res * 1.1)
      }
      state.step = step; state.iters = it + 1
      putBack()

      // Now the real pass, at this frame's blend weights.
      place(fTurn, fApp, step)
      lean(R[0], s.fwd, o.lean * fApp)
      lean(R[1], s.v.copy(s.fwd).negate(), o.lean * fApp)
      targets()
      solveArm(R[0], s.tgt[0], fIK)
      solveArm(R[1], s.tgt[1], fIK)
      state.residual = residual()

      // Fingers up, tipped a little toward the partner. A flat vertical palm is
      // what sells the slap.
      aimBone(R[0].hand, s.v.copy(UP).addScaledVector(s.fwd, 0.2).normalize(), fIK)
      aimBone(R[1].hand, s.v.copy(UP).addScaledVector(s.fwd, -0.2).normalize(), fIK)

      state.gap = this.gap()
      return state
    },

    /** Distance between the two wrist bones right now, metres. */
    gap() {
      R[0].hand.getWorldPosition(s.p)
      R[1].hand.getWorldPosition(s.tip)
      return s.p.distanceTo(s.tip)
    },

    handWorld(i) { return R[i].hand.getWorldPosition(new THREE.Vector3()) },

    /** Put the pair back where it was found, pose included. */
    reset() {
      putBack()
      for (let i = 0; i < 2; i++) {
        R[i].group.rotation.y = base[i].yaw
        R[i].group.position.copy(base[i].pos)
        R[i].group.updateMatrixWorld(true)
      }
    },
  }
}
