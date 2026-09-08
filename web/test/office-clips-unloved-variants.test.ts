import { describe, it, expect } from 'vitest'
import * as THREE from 'three'
import * as ANIM from '../src/office/anim.js'
import * as TIPTOE from '../src/office/clips/tiptoe.js'
import * as FACEPALM from '../src/office/clips/facepalm.js'

// Pure math over the two new rung-1/rung-4 alternate-take modules — no DOM,
// no renderer. Same shape as office-clips-geometry.test.ts (yield/
// doubletake, the bases these alternate) and
// office-clips-dominance-variants.test.ts (waveoff/slap, the abort-family
// alternates these are modeled on for the "ends mid-gesture, not at rest"
// convention).

function expectFacing(mark: { pos: THREE.Vector3; yaw: number }, other: THREE.Vector3) {
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
  { name: 'tiptoe', marksFn: TIPTOE.tiptoeMarks, spacingFor: TIPTOE.spacingFor, spacing: TIPTOE.TIPTOE_SPACING },
  { name: 'facepalm', marksFn: FACEPALM.facepalmMarks, spacingFor: FACEPALM.spacingFor, spacing: FACEPALM.FACEPALM_SPACING },
])('$name geometry', ({ marksFn, spacingFor, spacing }) => {
  it('spacing is positive and derived from authored geometry', () => {
    expect(spacing).toBeGreaterThan(0)
    expect(spacingFor(1.68)).toBeCloseTo(spacing, 6)
    expect(spacingFor(3.36)).toBeCloseTo(spacing * 2, 6)
  })

  it("marks are centred on the pair's midpoint", () => {
    const aPos = new THREE.Vector3(-1.1, 0, 0.4)
    const bPos = new THREE.Vector3(2.3, 0, -0.9)
    const marks = marksFn(aPos, bPos, spacing)
    const mid = new THREE.Vector3().addVectors(marks.a.pos, marks.b.pos).multiplyScalar(0.5)
    const expectedMid = new THREE.Vector3().addVectors(aPos, bPos).multiplyScalar(0.5)
    expectedMid.y = 0
    expect(mid.x).toBeCloseTo(expectedMid.x, 6)
    expect(mid.z).toBeCloseTo(expectedMid.z, 6)
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

describe('tiptoe clips', () => {
  it('registers the reader/editor pair with matching, positive durations', () => {
    expect(Object.keys(TIPTOE.registry).sort()).toEqual(['tiptoe', 'tiptoeOblivious'].sort())
    expect(TIPTOE.registry.tiptoe.dur).toBe(TIPTOE.registry.tiptoeOblivious.dur)
    expect(TIPTOE.registry.tiptoe.dur).toBeGreaterThan(0)
    expect(TIPTOE.registry.tiptoe.loop).toBe(false)
    expect(TIPTOE.registry.tiptoeOblivious.loop).toBe(false)
  })

  it('builds real AnimationClips with matching track/value lengths', () => {
    for (const name of ['tiptoe', 'tiptoeOblivious'] as const) {
      checkTrackShapes(ANIM.getClip(name))
    }
  })

  it('pose functions produce only finite numbers across the sampled range', () => {
    for (const name of ['tiptoe', 'tiptoeOblivious'] as const) {
      const spec = TIPTOE.registry[name]
      for (let i = 0; i < spec.keys; i++) {
        const pose = spec.fn(i / (spec.keys - 1))
        for (const k in pose) for (const v of pose[k]) expect(Number.isFinite(v)).toBe(true)
      }
    }
  })

  it('the reader ends up risen onto their toes, not back at rest', () => {
    const rest = TIPTOE.registry.tiptoe.fn(0)
    const end = TIPTOE.registry.tiptoe.fn(1)
    // Hips lift (pose.Hips[1]) should be well up from where it started.
    expect(end.Hips[1]).toBeGreaterThan(rest.Hips[1] + 3)
  })

  it('the editor stays close to a typing posture throughout — no big arm swing', () => {
    const spec = TIPTOE.registry.tiptoeOblivious
    for (let i = 0; i < spec.keys; i++) {
      const pose = spec.fn(i / (spec.keys - 1))
      // RightForeArm's flex (index 1) should stay in a narrow typing-ish
      // band the whole time — the whole joke is nothing dramatic happens.
      expect(Math.abs(pose.RightForeArm[1] - 70)).toBeLessThan(15)
    }
  })

  it('the editor never nods or looks up (unlike yield.js\'s yieldKeep)', () => {
    const early = TIPTOE.registry.tiptoeOblivious.fn(0.05)
    const late = TIPTOE.registry.tiptoeOblivious.fn(0.95)
    expect(Math.abs(late.Head[0] - early.Head[0])).toBeLessThan(2)
  })
})

describe('facepalm clips', () => {
  it('registers the pair with matching, positive durations', () => {
    expect(Object.keys(FACEPALM.registry).sort()).toEqual(['facepalm', 'shrug'].sort())
    expect(FACEPALM.registry.facepalm.dur).toBe(FACEPALM.registry.shrug.dur)
    expect(FACEPALM.registry.facepalm.dur).toBeGreaterThan(0)
    expect(FACEPALM.registry.facepalm.loop).toBe(false)
    expect(FACEPALM.registry.shrug.loop).toBe(false)
  })

  it('builds real AnimationClips with matching track/value lengths', () => {
    for (const name of ['facepalm', 'shrug'] as const) {
      checkTrackShapes(ANIM.getClip(name))
    }
  })

  it('pose functions produce only finite numbers across the sampled range', () => {
    for (const name of ['facepalm', 'shrug'] as const) {
      const spec = FACEPALM.registry[name]
      for (let i = 0; i < spec.keys; i++) {
        const pose = spec.fn(i / (spec.keys - 1))
        for (const k in pose) for (const v of pose[k]) expect(Number.isFinite(v)).toBe(true)
      }
    }
  })

  it('the facepalm hand ends up risen to head height, not back at rest', () => {
    const rest = FACEPALM.registry.facepalm.fn(0)
    const end = FACEPALM.registry.facepalm.fn(1)
    // RightForeArm's flex should have folded up substantially by the end.
    expect(end.RightForeArm[1]).toBeGreaterThan(rest.RightForeArm[1] + 60)
  })

  it('the shrug ends with both shoulders raised, not back at rest', () => {
    const rest = FACEPALM.registry.shrug.fn(0)
    const end = FACEPALM.registry.shrug.fn(1)
    expect(Math.abs(end.LeftShoulder[2])).toBeGreaterThan(Math.abs(rest.LeftShoulder[2]) + 5)
    expect(Math.abs(end.RightShoulder[2])).toBeGreaterThan(Math.abs(rest.RightShoulder[2]) + 5)
  })

  it('both sides share the same early "wait, is that..." realization beat', () => {
    // Before the gesture split (RISE_START), the two should already be
    // reacting — Head pitch away from rest — roughly together.
    const aEarly = FACEPALM.registry.facepalm.fn(0.22)
    const bEarly = FACEPALM.registry.shrug.fn(0.22)
    const aRest = FACEPALM.registry.facepalm.fn(0)
    const bRest = FACEPALM.registry.shrug.fn(0)
    expect(Math.abs(aEarly.Head[0] - aRest.Head[0])).toBeGreaterThan(3)
    expect(Math.abs(bEarly.Head[0] - bRest.Head[0])).toBeGreaterThan(3)
  })
})
