import { describe, it, expect } from 'vitest'
import * as THREE from 'three'
import * as ANIM from '../src/office/anim.js'
import * as WAVEOFF from '../src/office/clips/waveoff.js'
import * as SLAP from '../src/office/clips/slap.js'

// Pure math over the two dominance-beat variant modules — no DOM, no
// renderer. Same shape as office-clips-geometry.test.ts (yield/doubletake),
// adapted for asymmetric a-wins pairs like shove.js rather than the
// mutual/symmetric marks yield/doubletake use.

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
  { name: 'waveoff', marksFn: WAVEOFF.waveoffMarks, spacingFor: WAVEOFF.spacingFor, spacing: WAVEOFF.WAVEOFF_SPACING },
  { name: 'slap', marksFn: SLAP.slapMarks, spacingFor: SLAP.spacingFor, spacing: SLAP.SLAP_SPACING },
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

describe('waveoff clips', () => {
  it('registers the winner/loser pair with matching, positive durations', () => {
    expect(Object.keys(WAVEOFF.registry).sort()).toEqual(['waveoff', 'waveoffReact'])
    expect(WAVEOFF.registry.waveoff.dur).toBe(WAVEOFF.registry.waveoffReact.dur)
    expect(WAVEOFF.registry.waveoff.dur).toBeGreaterThan(0)
    expect(WAVEOFF.registry.waveoff.loop).toBe(false)
    expect(WAVEOFF.registry.waveoffReact.loop).toBe(false)
  })

  it('builds real AnimationClips with matching track/value lengths', () => {
    for (const name of ['waveoff', 'waveoffReact'] as const) {
      const clip = ANIM.getClip(name)
      checkTrackShapes(clip)
    }
  })

  it('pose functions produce only finite numbers across the sampled range', () => {
    for (const name of ['waveoff', 'waveoffReact'] as const) {
      const spec = WAVEOFF.registry[name]
      for (let i = 0; i < spec.keys; i++) {
        const t = i / (spec.keys - 1)
        const pose = spec.fn(t)
        for (const k in pose) for (const v of pose[k]) expect(Number.isFinite(v)).toBe(true)
      }
    }
  })

  it('the loser holds still until the winner is mid-sweep, then deflates', () => {
    // Reactor's own rest-hold window: nothing should move before it ends.
    const early = WAVEOFF.registry.waveoffReact.fn(0.05)
    const stillEarly = WAVEOFF.registry.waveoffReact.fn(0.20)
    expect(Math.abs(early.Head[0] - stillEarly.Head[0])).toBeLessThan(0.5)
    // By the end, the reactor should read as visibly deflated (head/torso
    // pitched down) relative to the held rest pose.
    const end = WAVEOFF.registry.waveoffReact.fn(1.0)
    expect(end.Head[0]).toBeGreaterThan(early.Head[0] + 5)
  })

  it('the loser shuffles back a smaller step than shove.js gives its loser', () => {
    const end = WAVEOFF.registry.waveoffReact.fn(1.0)
    // shove.js's STEP_BACK_CM is 34; this beat is a shuffle, not a shove.
    expect(Math.abs(end.hips[2])).toBeGreaterThan(0)
    expect(Math.abs(end.hips[2])).toBeLessThan(34)
  })
})

describe('slap clips', () => {
  it('registers the winner/loser pair with matching, positive durations', () => {
    expect(Object.keys(SLAP.registry).sort()).toEqual(['slap', 'slapReact'])
    expect(SLAP.registry.slap.dur).toBe(SLAP.registry.slapReact.dur)
    expect(SLAP.registry.slap.dur).toBeGreaterThan(0)
    expect(SLAP.registry.slap.loop).toBe(false)
    expect(SLAP.registry.slapReact.loop).toBe(false)
  })

  it('builds real AnimationClips with matching track/value lengths', () => {
    for (const name of ['slap', 'slapReact'] as const) {
      const clip = ANIM.getClip(name)
      checkTrackShapes(clip)
    }
  })

  it('pose functions produce only finite numbers across the sampled range', () => {
    for (const name of ['slap', 'slapReact'] as const) {
      const spec = SLAP.registry[name]
      for (let i = 0; i < spec.keys; i++) {
        const t = i / (spec.keys - 1)
        const pose = spec.fn(t)
        for (const k in pose) for (const v of pose[k]) expect(Number.isFinite(v)).toBe(true)
      }
    }
  })

  it('the wind-up is a real, held anticipation window before the fast swing', () => {
    // Barely anything should change across the anticipation hold...
    const windupStart = SLAP.registry.slap.fn(0.30)
    const windupHeld = SLAP.registry.slap.fn(0.40)
    expect(Math.abs(windupStart.RightArm[1] - windupHeld.RightArm[1])).toBeLessThan(1.0)
    // ...but the swing to contact covers a big arm-swing delta in a short
    // fraction of the clip (contact lands at SLAP_CONTACT_T).
    const contact = SLAP.registry.slap.fn(SLAP.SLAP_CONTACT_T)
    expect(Math.abs(contact.RightArm[1] - windupHeld.RightArm[1])).toBeGreaterThan(30)
  })

  it('the swing to contact is fast — most of the arc lands in a narrow window', () => {
    const spec = SLAP.registry.slap
    const dtPerSample = spec.dur / (spec.keys - 1)
    // The documented contact window (SL_WINDUP_HOLD_T .. SLAP_CONTACT_T) is
    // ~0.08 of the clip; confirm it is short in absolute seconds too, not
    // just as a fraction (a fast contact only reads as fast if it is also
    // fast in real time).
    const windowS = (SLAP.SLAP_CONTACT_T - 0.42) * spec.dur
    expect(windowS).toBeGreaterThan(0)
    expect(windowS).toBeLessThan(0.20)
    expect(dtPerSample).toBeLessThan(windowS)
  })

  it('the loser holds still until contact, then whips fast', () => {
    const preContact = SLAP.registry.slapReact.fn(SLAP.SLAP_CONTACT_T - 0.02)
    const rest = SLAP.registry.slapReact.fn(0.0)
    expect(Math.abs(preContact.Head[1] - rest.Head[1])).toBeLessThan(0.5)
    const postWhip = SLAP.registry.slapReact.fn(SLAP.SLAP_CONTACT_T + 0.08)
    expect(Math.abs(postWhip.Head[1] - rest.Head[1])).toBeGreaterThan(15)
  })

  it('the struck-cheek hand drift only appears late, easing in from zero', () => {
    const mid = SLAP.registry.slapReact.fn(0.55)
    const late = SLAP.registry.slapReact.fn(0.95)
    // LeftArm's ArmY should move further from its DAZED resting value by
    // the very end of the clip than mid-DAZED, since cheekEnvelope eases in
    // over the back half only.
    const rest = SLAP.registry.slapReact.fn(0.6)
    expect(Math.abs(late.LeftArm[1] - rest.LeftArm[1])).toBeGreaterThan(Math.abs(mid.LeftArm[1] - rest.LeftArm[1]) - 1e-6)
  })
})
