import { describe, it, expect } from 'vitest'
import * as THREE from 'three'
import * as YIELD from '../src/office/clips/yield.js'
import * as DT from '../src/office/clips/doubletake.js'

// Pure math over the two rung-1/rung-4 clip modules — no DOM, no renderer.
// Mirrors office-live.test.ts's plain describe/it-against-the-module shape.

function expectFacing(mark: { pos: THREE.Vector3; yaw: number }, other: THREE.Vector3) {
  // A mark's yaw should point from its own position towards the other
  // character's position (highfive.js's yawTowards convention: atan2(x, z)).
  const dir = new THREE.Vector3().subVectors(other, mark.pos)
  dir.y = 0
  const expectedYaw = Math.atan2(dir.x, dir.z)
  let d = expectedYaw - mark.yaw
  d = ((d % (2 * Math.PI)) + 3 * Math.PI) % (2 * Math.PI) - Math.PI
  expect(Math.abs(d)).toBeLessThan(1e-6)
}

function checkTrackShapes(clip: THREE.AnimationClip) {
  for (const track of clip.tracks) {
    const size = track.getValueSize()
    expect(track.values.length).toBe(track.times.length * size)
    expect(track.times.length).toBeGreaterThan(0)
  }
}

describe.each([
  { name: 'yield', marksFn: YIELD.yieldMarks, spacingFor: YIELD.spacingFor, spacing: YIELD.YIELD_SPACING },
  { name: 'doubletake', marksFn: DT.doubletakeMarks, spacingFor: DT.spacingFor, spacing: DT.DOUBLETAKE_SPACING },
])('$name geometry', ({ marksFn, spacingFor, spacing }) => {
  it('spacing is positive and derived from authored geometry', () => {
    expect(spacing).toBeGreaterThan(0)
    expect(spacingFor(1.68)).toBeCloseTo(spacing, 6)
    // Scales linearly with character height.
    expect(spacingFor(3.36)).toBeCloseTo(spacing * 2, 6)
  })

  it('marks are centred on the pair\'s midpoint', () => {
    const aPos = new THREE.Vector3(-1.1, 0, 0.4)
    const bPos = new THREE.Vector3(2.3, 0, -0.9)
    const marks = marksFn(aPos, bPos, spacing)
    const mid = new THREE.Vector3().addVectors(marks.a.pos, marks.b.pos).multiplyScalar(0.5)
    const expectedMid = new THREE.Vector3().addVectors(aPos, bPos).multiplyScalar(0.5)
    expectedMid.y = 0
    expect(mid.x).toBeCloseTo(expectedMid.x, 6)
    expect(mid.z).toBeCloseTo(expectedMid.z, 6)
    // Marks are `spacing` apart, on the a-b line.
    expect(marks.a.pos.distanceTo(marks.b.pos)).toBeCloseTo(spacing, 6)
  })

  it('marks face each other, whatever the starting positions/headings', () => {
    const cases: [THREE.Vector3, THREE.Vector3][] = [
      [new THREE.Vector3(-2, 0, 0), new THREE.Vector3(2, 0, 0)],
      [new THREE.Vector3(0, 0, -3), new THREE.Vector3(0, 0, 3)],
      [new THREE.Vector3(1, 0, 1), new THREE.Vector3(-4, 0, 5)],
    ]
    for (const [aPos, bPos] of cases) {
      const marks = marksFn(aPos, bPos, spacing)
      expectFacing(marks.a, marks.b.pos)
      expectFacing(marks.b, marks.a.pos)
    }
  })

  it('degenerate case (coincident start positions) does not produce NaN marks', () => {
    const p = new THREE.Vector3(1, 0, 1)
    const marks = marksFn(p, p, spacing)
    expect(Number.isFinite(marks.a.pos.x)).toBe(true)
    expect(Number.isFinite(marks.a.yaw)).toBe(true)
    expect(Number.isFinite(marks.b.pos.x)).toBe(true)
    expect(Number.isFinite(marks.b.yaw)).toBe(true)
  })
})

describe('yield clips', () => {
  it('registers both roles with positive durations', () => {
    expect(Object.keys(YIELD.registry).sort()).toEqual(['yieldKeep', 'yieldStep'])
    for (const name of ['yieldStep', 'yieldKeep'] as const) {
      expect(YIELD.registry[name].dur).toBeGreaterThan(0)
      expect(YIELD.registry[name].keys).toBeGreaterThan(1)
      expect(YIELD.registry[name].loop).toBe(false)
    }
  })

  it('builds real AnimationClips with matching track/value lengths', () => {
    for (const name of ['yieldStep', 'yieldKeep'] as const) {
      const clip = YIELD.getClip(name)
      expect(clip.duration).toBeCloseTo(YIELD.YIELD_DUR, 6)
      checkTrackShapes(clip)
    }
  })

  it('pose functions produce only finite numbers across the sampled range', () => {
    for (const name of ['yieldStep', 'yieldKeep'] as const) {
      const spec = YIELD.registry[name]
      for (let i = 0; i < spec.keys; i++) {
        const t = i / (spec.keys - 1)
        const pose = spec.fn(t)
        for (const k in pose) for (const v of pose[k]) expect(Number.isFinite(v)).toBe(true)
      }
    }
  })
})

describe('doubletake clip', () => {
  it('registers one symmetric clip with a positive duration', () => {
    expect(Object.keys(DT.registry)).toEqual(['doubletake'])
    expect(DT.registry.doubletake.dur).toBeGreaterThan(0)
    expect(DT.registry.doubletake.keys).toBeGreaterThan(1)
    expect(DT.registry.doubletake.loop).toBe(false)
  })

  it('builds a real AnimationClip with matching track/value lengths', () => {
    const clip = DT.getClip()
    expect(clip.duration).toBeCloseTo(DT.DOUBLETAKE_DUR, 6)
    checkTrackShapes(clip)
  })

  it('starts and ends at rest — loop seam is ~0 even though it is a one-shot', () => {
    const spec = DT.registry.doubletake
    const p0 = spec.fn(0)
    const p1 = spec.fn(1)
    let max = 0
    for (const k in p0) {
      const v0 = p0[k]
      const v1 = p1[k]
      if (!v1) continue
      for (let i = 0; i < Math.max(v0.length, v1.length); i++) {
        max = Math.max(max, Math.abs((v0[i] ?? 0) - (v1[i] ?? 0)))
      }
    }
    expect(max).toBeLessThan(0.5)
  })

  it('the pause before the snap is a real, nonzero window', () => {
    // Comic timing check: the "away" hold has to actually sit still for a
    // beat before the snap starts, not blend continuously into it.
    const away = DT.registry.doubletake.fn(0.36)
    const stillAway = DT.registry.doubletake.fn(0.44)
    // Head yaw barely moves across the pause window...
    expect(Math.abs(away.Head[1] - stillAway.Head[1])).toBeLessThan(1.0)
    // ...but has snapped hard back by partway through the snap window.
    const midSnap = DT.registry.doubletake.fn(0.51)
    expect(Math.abs(midSnap.Head[1] - away.Head[1])).toBeGreaterThan(8)
  })

  it('pose function produces only finite numbers across the sampled range', () => {
    const spec = DT.registry.doubletake
    for (let i = 0; i < spec.keys; i++) {
      const t = i / (spec.keys - 1)
      const pose = spec.fn(t)
      for (const k in pose) for (const v of pose[k]) expect(Number.isFinite(v)).toBe(true)
    }
  })
})
