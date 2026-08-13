import { describe, it, expect } from 'vitest'
import { holdSpec, endPose, holdPair, holdSame } from '../src/office/clips/sustain.js'

// Pure math over clips/sustain.js — the shared end-pose hold builder every
// resolution act's replay chain stage uses (see agent.js's
// REPLAY_CHAINS / REPLAY_VARIANT_STAGE). No DOM, no renderer, no rig.

const SOME_POSE = {
  hips: [0, 0, 20],
  Hips: [0, 0, 0],
  Spine02: [8, 12, 0],
  Spine01: [6, 12, 0],
  neck: [4, -4, 0],
  Head: [4, -6, 0],
  LeftArm: [-6, 10, -16],
  RightArm: [-6, 10, 16],
}

describe('holdSpec', () => {
  it('carries every source pose key through unchanged in shape', () => {
    const spec = holdSpec(SOME_POSE, 1.3, 'settle')
    const p0 = spec.fn(0)
    expect(Object.keys(p0).sort()).toEqual(Object.keys(SOME_POSE).sort())
    for (const k in SOME_POSE) expect(p0[k].length).toBe(SOME_POSE[k].length)
  })

  it('does not mutate the source pose object', () => {
    const src = JSON.parse(JSON.stringify(SOME_POSE))
    const spec = holdSpec(SOME_POSE, 1.3, 'settle')
    spec.fn(0.5)
    expect(SOME_POSE).toEqual(src)
  })

  it('is a real clip spec: positive duration, sane key count, not looping', () => {
    const spec = holdSpec(SOME_POSE, 1.3, 'settle')
    expect(spec.dur).toBe(1.3)
    expect(spec.keys).toBeGreaterThan(1)
    expect(spec.loop).toBe(false)
  })

  it('eases in from the exact source pose rather than popping at t=0', () => {
    const spec = holdSpec(SOME_POSE, 1.3, 'settle')
    const p0 = spec.fn(0)
    expect(p0.Spine02[0]).toBeCloseTo(SOME_POSE.Spine02[0], 6)
    expect(p0.hips[1]).toBeCloseTo(SOME_POSE.hips[1], 6)
  })

  it('produces only finite numbers across the sampled range', () => {
    for (const role of ['settle', 'deflate'] as const) {
      const spec = holdSpec(SOME_POSE, 1.4, role)
      for (let i = 0; i < spec.keys; i++) {
        const pose = spec.fn(i / (spec.keys - 1))
        for (const k in pose) for (const v of pose[k]) expect(Number.isFinite(v)).toBe(true)
      }
    }
  })

  it('actually moves during the hold — not a dead freeze', () => {
    const spec = holdSpec(SOME_POSE, 1.4, 'settle')
    const samples = []
    for (let i = 0; i < spec.keys; i++) samples.push(spec.fn(i / (spec.keys - 1)).Spine02[0])
    const spread = Math.max(...samples) - Math.min(...samples)
    expect(spread).toBeGreaterThan(0.05)
  })

  it('settle and deflate read as different characters of motion', () => {
    const settle = holdSpec(SOME_POSE, 1.4, 'settle')
    const deflate = holdSpec(SOME_POSE, 1.4, 'deflate')
    const settleAt = settle.fn(0.5).Spine02[0]
    const deflateAt = deflate.fn(0.5).Spine02[0]
    // Different phase/amplitude/frequency inputs — at a fixed sample point
    // they should not coincide (a lazy 'deflate = settle' bug would).
    expect(settleAt).not.toBeCloseTo(deflateAt, 3)
  })

  it('is deterministic — same inputs, same output, every call', () => {
    const spec = holdSpec(SOME_POSE, 1.4, 'deflate')
    expect(spec.fn(0.37)).toEqual(spec.fn(0.37))
  })
})

describe('endPose / holdPair / holdSame', () => {
  const registry = {
    winner: { fn: (t: number) => ({ Spine02: [10 * t, 0, 0], hips: [0, 0, 0] }), dur: 1, keys: 10, loop: false },
    loser: { fn: (t: number) => ({ Spine02: [-5 * t, 0, 0], hips: [0, 0, 20] }), dur: 1, keys: 10, loop: false },
  }

  it('endPose reads the t=1 frame', () => {
    expect(endPose(registry.winner)).toEqual({ Spine02: [10, 0, 0], hips: [0, 0, 0] })
  })

  it('holdPair builds a settle spec off a and a deflate spec off b', () => {
    const { a, b } = holdPair(registry, 'winner', 'loser', 1.2)
    expect(a.dur).toBe(1.2)
    expect(b.dur).toBe(1.2)
    // settle starts at winner's own end pose, deflate at loser's.
    expect(a.fn(0).Spine02[0]).toBeCloseTo(10, 6)
    expect(b.fn(0).Spine02[0]).toBeCloseTo(-5, 6)
  })

  it('holdSame builds one settle spec both sides can share', () => {
    const spec = holdSame(registry, 'winner', 1.1)
    expect(spec.dur).toBe(1.1)
    expect(spec.fn(0).Spine02[0]).toBeCloseTo(10, 6)
  })
})
