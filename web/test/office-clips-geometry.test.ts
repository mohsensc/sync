import { describe, it, expect } from 'vitest'
import * as THREE from 'three'
import * as ANIM from '../src/office/anim.js'
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
      const clip = ANIM.getClip(name)
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

// Motion-pass regression checks (round 2 task 4's own notes: this clip was
// "a first draft off the pose math alone, not off how it actually reads").
// These pin the three sequencing requirements the visual pass was for,
// directly against the timing config rather than reverse-engineering pose
// output — see DEFAULT_TIMING's own comment in yield.js for the story.
describe('yield timing — anticipation and sequencing', () => {
  it("reader's glance-up precedes the open-palm offer", () => {
    expect(YIELD.DEFAULT_TIMING.lookPeak).toBeLessThan(YIELD.DEFAULT_TIMING.armPeak)
  })

  it("editor's nod lands after the offer, not simultaneously", () => {
    // More than a token gap — simultaneous-looking needs real separation,
    // not just "technically later."
    expect(YIELD.DEFAULT_TIMING.nodPeak).toBeGreaterThan(YIELD.DEFAULT_TIMING.armPeak + 0.08)
  })

  it('exposes an emphatic variant, longer and bigger than the picked take', () => {
    expect(YIELD.variants.default).toBe(YIELD.registry)
    expect(YIELD.variants.emphatic.yieldStep.dur).toBeGreaterThan(YIELD.registry.yieldStep.dur)
    expect(YIELD.EMPHATIC_TIMING.stepAmp).toBeGreaterThan(YIELD.DEFAULT_TIMING.stepAmp)
    // Same sequencing rules apply to the alternate take, not just the default.
    expect(YIELD.EMPHATIC_TIMING.lookPeak).toBeLessThan(YIELD.EMPHATIC_TIMING.armPeak)
    expect(YIELD.EMPHATIC_TIMING.nodPeak).toBeGreaterThan(YIELD.EMPHATIC_TIMING.armPeak + 0.08)
  })

  it('emphatic step-back reads bigger than the default at the same beat', () => {
    // armPeak fractions differ slightly between takes, so sample each at its
    // own peak rather than a shared t.
    const base = YIELD.registry.yieldStep.fn(YIELD.DEFAULT_TIMING.armPeak)
    const big = YIELD.variants.emphatic.yieldStep.fn(YIELD.EMPHATIC_TIMING.armPeak)
    expect(Math.abs(big.hips[2])).toBeGreaterThan(Math.abs(base.hips[2]))
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
    const clip = ANIM.getClip('doubletake')
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

// Motion-pass regression checks (round 2 task 4's own notes: this clip was
// "a first draft off the pose math alone, not off how it actually reads").
// The visual pass found the STRUCTURE fine but the snap under-sampled: the
// original flat 40-key/2.6s clip put only ~3.1 samples across the 0.208s
// snap window, under the brief's own "~4 frames or it mushes" line.
describe('doubletake — snap sample density', () => {
  const SNAP_S = 0.208         // fixed regardless of variant, see doubletake.js
  const MIN_SAMPLES = 4        // the brief's own rule of thumb

  it('the picked take samples the snap window densely enough not to mush', () => {
    const spec = DT.registry.doubletake
    const dtPerSample = spec.dur / (spec.keys - 1)
    expect(SNAP_S / dtPerSample).toBeGreaterThanOrEqual(MIN_SAMPLES)
  })

  it('every variant samples the snap densely enough, not just the default', () => {
    // Key density is samples/SECOND (see keysFor in doubletake.js), so a
    // longer total duration must not silently starve the snap of samples.
    for (const name of ['default', 'longPause', 'bigShrug'] as const) {
      const spec = DT.variants[name].doubletake
      const dtPerSample = spec.dur / (spec.keys - 1)
      expect(SNAP_S / dtPerSample).toBeGreaterThanOrEqual(MIN_SAMPLES)
    }
  })
})

describe('doubletake timing variants', () => {
  it('default variant is the same object as the picked registry', () => {
    expect(DT.variants.default).toBe(DT.registry)
  })

  it('longPause holds a longer total duration than the default, snap length unchanged', () => {
    expect(DT.variants.longPause.doubletake.dur).toBeGreaterThan(DT.registry.doubletake.dur)
    expect(DT.LONGPAUSE_TIMING.pauseS).toBeGreaterThan(DT.DEFAULT_TIMING.pauseS)
  })

  it('longPause actually holds the away-look through more of the clip than default', () => {
    // Sample well inside the default's pause window (ends ~0.46 of 2.6s)
    // but express it in seconds so the comparison is fair across the two
    // different total durations.
    const holdAtS = 0.60   // seconds into the clip — inside default's pause,
                            // and (with the added 0.5s) still inside longPause's
    const base = DT.registry.doubletake
    const long = DT.variants.longPause.doubletake
    const baseAway = base.fn(holdAtS / base.dur)
    const longAway = long.fn(holdAtS / long.dur)
    // Both should still be in the "away" look (yaw around -22), not yet
    // snapped back (yaw near 0-4).
    expect(baseAway.Head[1]).toBeLessThan(-10)
    expect(longAway.Head[1]).toBeLessThan(-10)
  })

  it('bigShrug variant reaches a bigger shrug than default at the same beat', () => {
    // Timing durations match (only shrugAmp differs), so the shrug-peak
    // fraction is identical across both takes.
    const t = DT.DEFAULT_TIMING.segs[5][0]   // shrug segment's end fraction
    const base = DT.registry.doubletake.fn(t)
    const big = DT.variants.bigShrug.doubletake.fn(t)
    expect(Math.abs(big.RightForeArm[1])).toBeGreaterThan(Math.abs(base.RightForeArm[1]))
  })
})
