import { describe, it, expect } from 'vitest'
import * as THREE from 'three'
import { clearMarks } from '../src/office/agent.js'
import { highfiveMarks, HIGHFIVE_SPACING } from '../src/office/highfive.js'
import { ZONES } from '../src/office/zones.js'

// zones.js's BOUNDS, mirrored rather than imported: zones.d.ts belongs to
// fix/head-framing (this branch stacks on it, doesn't touch it), and it
// doesn't export BOUNDS. Values match zones.js's own comment: room is
// 18 x 13.6, shell inset to x [-8.3, 8.4], z [-6.0, 6.3].
const BOUNDS = { minX: -8.3, maxX: 8.4, minZ: -6.0, maxZ: 6.3 }

// Pure math over clearMarks() — no DOM, no World, no agents. Patterned on
// office-clips-geometry.test.ts: build real marks with a real *Marks()
// helper (highfiveMarks, same shape every STAGE_MARKS entry returns), then
// assert clearMarks's own invariants against them.
//
// #65 claims a desk-block nudge ("toOpenFloor()", "round 4") already
// existed and only needed a live-agent check bolted on. It doesn't exist —
// no branch, no commit — so this suite is the whole thing: desk-cluster
// avoidance and live-agent avoidance both land here.

function marksFor(ax: number, az: number, bx: number, bz: number) {
  return highfiveMarks(
    new THREE.Vector3(ax, 0, az),
    new THREE.Vector3(bx, 0, bz),
    HIGHFIVE_SPACING
  )
}

function dist(x1: number, z1: number, x2: number, z2: number) {
  return Math.hypot(x1 - x2, z1 - z2)
}

describe('clearMarks', () => {
  it('no-op when there are no obstacles', () => {
    const marks = marksFor(-1, 0, 1, 0)
    const before = { a: marks.a.pos.clone(), b: marks.b.pos.clone() }
    clearMarks(marks, [])
    // clearMarks rewrites both positions from the recomputed midpoint even
    // on a no-push path, so this only round-trips exactly when (a+b)/2
    // reproduces the original midpoint bit-for-bit — true here, not a
    // contract clearMarks makes. toBeCloseTo is the real invariant.
    expect(marks.a.pos.x).toBeCloseTo(before.a.x, 9)
    expect(marks.a.pos.z).toBeCloseTo(before.a.z, 9)
    expect(marks.b.pos.x).toBeCloseTo(before.b.x, 9)
    expect(marks.b.pos.z).toBeCloseTo(before.b.z, 9)
  })

  it('no-op when the pair is already clear of every obstacle', () => {
    const marks = marksFor(-1, 0, 1, 0)
    const before = { a: marks.a.pos.clone(), b: marks.b.pos.clone() }
    clearMarks(marks, [{ x: 20, z: 20, r: 1 }])
    expect(marks.a.pos.x).toBeCloseTo(before.a.x, 9)
    expect(marks.a.pos.z).toBeCloseTo(before.a.z, 9)
    expect(marks.b.pos.x).toBeCloseTo(before.b.x, 9)
    expect(marks.b.pos.z).toBeCloseTo(before.b.z, 9)
  })

  it('pushes the pair clear of a single obstacle at their midpoint', () => {
    const marks = marksFor(-1, 0, 1, 0)
    const spacing = marks.spacing
    const yawA = marks.a.yaw, yawB = marks.b.yaw
    clearMarks(marks, [{ x: 0, z: 0, r: 2 }])
    const mid = new THREE.Vector3().addVectors(marks.a.pos, marks.b.pos).multiplyScalar(0.5)
    // Cleared: the pair's own half-spacing disc no longer overlaps the
    // obstacle (small numerical margin over the exact boundary).
    expect(dist(mid.x, mid.z, 0, 0)).toBeGreaterThan(2 + spacing / 2 - 1e-6)
    // Rigid unit: separation and facing survive the push untouched.
    expect(marks.a.pos.distanceTo(marks.b.pos)).toBeCloseTo(spacing, 6)
    expect(marks.a.yaw).toBeCloseTo(yawA, 6)
    expect(marks.b.yaw).toBeCloseTo(yawB, 6)
  })

  it('desk cluster: pair starting on top of a desk slot ends clear of every slot', () => {
    // #clearanceObstacles builds one small obstacle per ZONES.desks.slot —
    // NOT one big circle at ZONES.desks.at/r, which is the zone's label
    // ring (see agent.js's DESK_CLEARANCE comment) and would swallow most
    // of the floor. Mirror that derivation here rather than making up an
    // obstacle shape of its own.
    const DESK_CLEARANCE = 0.9
    const deskObstacles = ZONES.desks.slots.map(([x, z]) => ({ x, z, r: DESK_CLEARANCE }))
    const [sx, sz] = ZONES.desks.slots[1] // land the pair right on a slot
    const marks = marksFor(sx - 0.1, sz, sx + 0.1, sz)
    // Default maxTries — this is the same call #startChain/#advanceChain
    // make in production, not a relaxed test-only cap.
    clearMarks(marks, deskObstacles)
    const mid = new THREE.Vector3().addVectors(marks.a.pos, marks.b.pos).multiplyScalar(0.5)
    for (const o of deskObstacles) {
      expect(dist(mid.x, mid.z, o.x, o.z)).toBeGreaterThan(o.r)
    }
  })

  it('live-agent obstacle: nudges the pair off a bystander standing at the midpoint', () => {
    const marks = marksFor(-0.5, 3, 0.5, 3)
    const bystander = { x: 0, z: 3, r: 0.7 }
    clearMarks(marks, [bystander])
    const mid = new THREE.Vector3().addVectors(marks.a.pos, marks.b.pos).multiplyScalar(0.5)
    expect(dist(mid.x, mid.z, bystander.x, bystander.z)).toBeGreaterThan(bystander.r)
  })

  it('obstacle exactly on the midpoint: zero-length push resolves deterministically, no NaN', () => {
    const marks = marksFor(-1, 0, 1, 0)
    clearMarks(marks, [{ x: 0, z: 0, r: 1 }])
    expect(Number.isFinite(marks.a.pos.x)).toBe(true)
    expect(Number.isFinite(marks.a.pos.z)).toBe(true)
    expect(Number.isFinite(marks.b.pos.x)).toBe(true)
    expect(Number.isFinite(marks.b.pos.z)).toBe(true)
    expect(Number.isFinite(marks.a.yaw)).toBe(true)
    expect(Number.isFinite(marks.b.yaw)).toBe(true)

    // Same obstacle-on-midpoint case, run twice from the same inputs: the
    // fallback direction has to be the same result both times, not
    // whichever way float noise leans.
    const marksAgain = marksFor(-1, 0, 1, 0)
    clearMarks(marksAgain, [{ x: 0, z: 0, r: 1 }])
    expect(marksAgain.a.pos.x).toBeCloseTo(marks.a.pos.x, 6)
    expect(marksAgain.a.pos.z).toBeCloseTo(marks.a.pos.z, 6)
  })

  it('nowhere clear: caps the search and returns a finite, least-bad point instead of hanging', () => {
    // One obstacle bigger than the room, centred mid-floor: no point inside
    // BOUNDS clears it, so the search runs out its cap, the post-loop clamp
    // pulls the midpoint back inside BOUNDS, and the obstacle overlap is
    // unavoidably still there. That's the real "nowhere clear" contract —
    // finite, still a rigid unit, no hang — not "escapes in a couple of
    // pushes because the ring had a gap".
    const marks = marksFor(-1, 0, 1, 0)
    const obstacle = { x: 0, z: 0, r: 50 }
    clearMarks(marks, [obstacle], { maxTries: 8 })
    expect(Number.isFinite(marks.a.pos.x)).toBe(true)
    expect(Number.isFinite(marks.a.pos.z)).toBe(true)
    expect(Number.isFinite(marks.b.pos.x)).toBe(true)
    expect(Number.isFinite(marks.b.pos.z)).toBe(true)
    // Still a rigid unit even when the search never fully clears.
    expect(marks.a.pos.distanceTo(marks.b.pos)).toBeCloseTo(marks.spacing, 6)
  })

  it('maxTries actually caps the search — more tries reach a clearer point', () => {
    // Second obstacle sits off-axis from the first push's escape direction,
    // so clearing it takes a second, differently-aimed push — maxTries: 1
    // stops after the first and is still overlapping it; a generous cap
    // keeps going and lands somewhere else entirely.
    const obstacles = [
      { x: 0, z: 0, r: 1.5 },       // sits on the pair's own midpoint
      { x: 1.0, z: 2.104, r: 1.0 }, // offset from where the first push lands
    ]
    const capped = marksFor(-1, 0, 1, 0)
    clearMarks(capped, obstacles, { maxTries: 1 })
    const full = marksFor(-1, 0, 1, 0)
    clearMarks(full, obstacles, { maxTries: 8 })
    const cappedMid = new THREE.Vector3().addVectors(capped.a.pos, capped.b.pos).multiplyScalar(0.5)
    const fullMid = new THREE.Vector3().addVectors(full.a.pos, full.b.pos).multiplyScalar(0.5)
    expect(cappedMid.distanceTo(fullMid)).toBeGreaterThan(0.01)
  })

  it('clamps a displaced midpoint back inside BOUNDS', () => {
    // Start right at the edge, with an obstacle that can only push further
    // outward — without the clamp this lands past the wall.
    const marks = marksFor(BOUNDS.maxX - 0.2, 0, BOUNDS.maxX + 0.2, 0)
    clearMarks(marks, [{ x: BOUNDS.maxX - 5, z: 0, r: 6 }])
    expect(marks.a.pos.x).toBeLessThanOrEqual(BOUNDS.maxX + 1e-6)
    expect(marks.b.pos.x).toBeLessThanOrEqual(BOUNDS.maxX + 1e-6)
    expect(Number.isFinite(marks.a.pos.x)).toBe(true)
    expect(Number.isFinite(marks.b.pos.x)).toBe(true)
  })

  it('spacing and facing are unchanged by clearance, across several obstacle layouts', () => {
    const layouts: [number, number, number, number][] = [
      [-2, -1, 2, 1],
      [0, 0, 0.01, 0.02],
      [5, -3, 5.5, -3.4],
    ]
    for (const [ax, az, bx, bz] of layouts) {
      const marks = marksFor(ax, az, bx, bz)
      const spacing = marks.spacing
      const axis = new THREE.Vector3().subVectors(marks.b.pos, marks.a.pos).normalize()
      clearMarks(marks, [{ x: ax, z: az, r: 3 }])
      expect(marks.a.pos.distanceTo(marks.b.pos)).toBeCloseTo(spacing, 6)
      const newAxis = new THREE.Vector3().subVectors(marks.b.pos, marks.a.pos).normalize()
      expect(newAxis.x).toBeCloseTo(axis.x, 5)
      expect(newAxis.z).toBeCloseTo(axis.z, 5)
    }
  })
})
