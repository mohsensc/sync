import { describe, it, expect } from 'vitest'
import * as THREE from 'three'
import * as ANIM from '../src/office/anim.js'
import * as CHESTBUMP from '../src/office/clips/chestbump.js'
import * as FISTBUMP from '../src/office/clips/fistbump.js'

// Pure math over the two rung-2 collaboration-beat variant modules — no
// DOM, no renderer. Same shape as office-clips-geometry.test.ts (yield/
// doubletake) and office-clips-dominance-variants.test.ts (waveoff/slap),
// adapted for mutual/symmetric marks (both sides travel to a shared point)
// like highfive.js/handshake.js rather than the asymmetric a-wins pairs.

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
  { name: 'chestbump', marksFn: CHESTBUMP.chestbumpMarks, spacingFor: CHESTBUMP.spacingFor, spacing: CHESTBUMP.CHESTBUMP_SPACING },
  { name: 'fistbump', marksFn: FISTBUMP.fistbumpMarks, spacingFor: FISTBUMP.spacingFor, spacing: FISTBUMP.FISTBUMP_SPACING },
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

describe('chestbump clip', () => {
  it('registers one symmetric clip with a positive duration', () => {
    expect(Object.keys(CHESTBUMP.registry)).toEqual(['chestbump'])
    expect(CHESTBUMP.registry.chestbump.dur).toBeGreaterThan(0)
    expect(CHESTBUMP.registry.chestbump.keys).toBeGreaterThan(1)
    expect(CHESTBUMP.registry.chestbump.loop).toBe(false)
  })

  it('builds a real AnimationClip with matching track/value lengths', () => {
    const clip = ANIM.getClip('chestbump')
    expect(clip.duration).toBeCloseTo(CHESTBUMP.CHESTBUMP_SPEC.dur, 6)
    checkTrackShapes(clip)
  })

  it('starts and ends at rest, even though it is a one-shot', () => {
    const spec = CHESTBUMP.registry.chestbump
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

  it('pose function produces only finite numbers across the sampled range', () => {
    const spec = CHESTBUMP.registry.chestbump
    for (let i = 0; i < spec.keys; i++) {
      const t = i / (spec.keys - 1)
      const pose = spec.fn(t)
      for (const k in pose) for (const v of pose[k]) expect(Number.isFinite(v)).toBe(true)
    }
  })

  it('there is a real anticipation dip (crouch) before the hop rises', () => {
    // The crouch sinks the hips below rest before the launch carries them
    // up past it — a real anticipation, not a flat ramp straight to contact.
    const rest = CHESTBUMP.registry.chestbump.fn(0)
    const crouch = CHESTBUMP.registry.chestbump.fn(CHESTBUMP.CHESTBUMP_CROUCH_T)
    const contact = CHESTBUMP.registry.chestbump.fn(CHESTBUMP.CHESTBUMP_CONTACT_T)
    expect(crouch.hips[1]).toBeLessThan(rest.hips[1])
    expect(contact.hips[1]).toBeGreaterThan(crouch.hips[1])
  })

  it('the hips carry real forward travel at contact (a hop, not a lean-only reach)', () => {
    const contact = CHESTBUMP.registry.chestbump.fn(CHESTBUMP.CHESTBUMP_CONTACT_T)
    expect(contact.hips[2]).toBeGreaterThan(15)
  })

  it('there is a visible recoil off contact before landing', () => {
    // The torso lean snaps from a forward reach at contact to an arch back
    // during recoil — the "bounce-back" the brief asks for.
    const contact = CHESTBUMP.registry.chestbump.fn(CHESTBUMP.CHESTBUMP_CONTACT_T)
    const recoil = CHESTBUMP.registry.chestbump.fn(CHESTBUMP.CHESTBUMP_RECOIL_T)
    expect(contact.Spine02[0]).toBeGreaterThan(0)
    expect(recoil.Spine02[0]).toBeLessThan(0)
  })

  it('the landing absorbs with a deeper knee bend than contact carried', () => {
    const contact = CHESTBUMP.registry.chestbump.fn(CHESTBUMP.CHESTBUMP_CONTACT_T)
    const land = CHESTBUMP.registry.chestbump.fn(CHESTBUMP.CHESTBUMP_LAND_T)
    expect(land.RightLeg[0]).toBeGreaterThan(contact.RightLeg[0])
  })

  it('the contact frame lands each side on its own midline (chestPoint x ~= 0)', () => {
    const p = CHESTBUMP.measureContact()
    expect(p).not.toBeNull()
    expect(Math.abs(p!.x)).toBeLessThan(2)
    expect(p!.z).toBeGreaterThan(0)
  })
})

describe('fistbump clip', () => {
  it('registers one symmetric clip with a positive duration', () => {
    expect(Object.keys(FISTBUMP.registry)).toEqual(['fistbump'])
    expect(FISTBUMP.registry.fistbump.dur).toBeGreaterThan(0)
    expect(FISTBUMP.registry.fistbump.keys).toBeGreaterThan(1)
    expect(FISTBUMP.registry.fistbump.loop).toBe(false)
  })

  it('builds a real AnimationClip with matching track/value lengths', () => {
    const clip = ANIM.getClip('fistbump')
    expect(clip.duration).toBeCloseTo(FISTBUMP.FISTBUMP_SPEC.dur, 6)
    checkTrackShapes(clip)
  })

  it('starts and ends at rest, even though it is a one-shot', () => {
    const spec = FISTBUMP.registry.fistbump
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

  it('pose function produces only finite numbers across the sampled range', () => {
    const spec = FISTBUMP.registry.fistbump
    for (let i = 0; i < spec.keys; i++) {
      const t = i / (spec.keys - 1)
      const pose = spec.fn(t)
      for (const k in pose) for (const v of pose[k]) expect(Number.isFinite(v)).toBe(true)
    }
  })

  it('is quick and understated: much shorter than the chest bump', () => {
    expect(FISTBUMP.FISTBUMP_SPEC.dur).toBeLessThan(CHESTBUMP.CHESTBUMP_SPEC.dur)
    // No hop, no lean: hips and torso never move at all, unlike chestbump's.
    const spec = FISTBUMP.registry.fistbump
    for (let i = 0; i < spec.keys; i++) {
      const pose = spec.fn(i / (spec.keys - 1))
      expect(pose.hips).toEqual([0, 0, 0])
      expect(pose.Spine02).toEqual([0, 0, 0])
    }
  })

  it('holds still at contact for a real beat before parting', () => {
    const contact = FISTBUMP.registry.fistbump.fn(FISTBUMP.FISTBUMP_CONTACT_T)
    const held = FISTBUMP.registry.fistbump.fn((FISTBUMP.FISTBUMP_CONTACT_T + FISTBUMP.FISTBUMP_HOLD_END_T) / 2)
    expect(Math.abs(contact.RightArm[1] - held.RightArm[1])).toBeLessThan(0.5)
    expect(Math.abs(contact.RightHand[0] - held.RightHand[0])).toBeLessThan(0.5)
  })

  it('the arm returns most of the way to rest after the hold', () => {
    const rest = FISTBUMP.registry.fistbump.fn(0)
    const held = FISTBUMP.registry.fistbump.fn(FISTBUMP.FISTBUMP_HOLD_END_T)
    const end = FISTBUMP.registry.fistbump.fn(1)
    const heldDist = Math.abs(held.RightArm[1] - rest.RightArm[1])
    const endDist = Math.abs(end.RightArm[1] - rest.RightArm[1])
    expect(endDist).toBeLessThan(heldDist)
  })

  it('the contact frame lands close to the character\'s own midline', () => {
    const p = FISTBUMP.measureContact()
    expect(p).not.toBeNull()
    expect(Math.abs(p!.x)).toBeLessThan(5)
    expect(p!.z).toBeGreaterThan(0)
  })
})
