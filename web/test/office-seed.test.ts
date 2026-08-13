// seed.js's generated fallback history. Pure data, no DOM, mirrors
// office-live.test.ts's plain-import style.

import { describe, it, expect } from 'vitest'
import { seedEvents } from '../src/office/seed.js'

const NOW = 1_700_000_000_000

describe('seedEvents', () => {
  it('is deterministic given the same now', () => {
    expect(seedEvents(NOW)).toEqual(seedEvents(NOW))
  })

  it('produces different output for a different now, but the same shape', () => {
    const a = seedEvents(NOW)
    const b = seedEvents(NOW + 60_000)
    expect(a).not.toEqual(b)
    expect(a.length).toBe(b.length)
  })

  it('returns about 25 events', () => {
    expect(seedEvents(NOW).length).toBe(25)
  })

  it('every event is tagged generated, never live', () => {
    for (const e of seedEvents(NOW)) expect(e.source).toBe('generated')
  })

  it('covers every rung 0-4', () => {
    const rungs = new Set(seedEvents(NOW).map(e => e.rung))
    expect([...rungs].sort()).toEqual([0, 1, 2, 3, 4])
  })

  it('matches the schema shape on every event', () => {
    for (const e of seedEvents(NOW)) {
      expect(typeof e.id).toBe('string')
      expect(e.id.length).toBeGreaterThan(0)
      expect(typeof e.ts).toBe('number')
      expect([0, 1, 2, 3, 4]).toContain(e.rung)
      expect(typeof e.a.agent).toBe('string')
      expect(typeof e.a.human).toBe('string')
      expect(typeof e.b.agent).toBe('string')
      expect(typeof e.b.human).toBe('string')
      expect(typeof e.path).toBe('string')
      expect(e.path.length).toBeGreaterThan(0)
      expect(e.source).toBe('generated')
    }
  })

  it('respects the rung -> resolution mapping', () => {
    for (const e of seedEvents(NOW)) {
      if (e.rung === 0) expect(e.resolution).toBeNull()
      if (e.rung === 1) expect(e.resolution).toEqual({ kind: 'read-yield' })
      if (e.rung === 2) expect(e.resolution).toEqual({ kind: 'share' })
      if (e.rung === 3) expect(['wait', 'abort']).toContain(e.resolution!.kind)
      if (e.rung === 4) expect(e.resolution!.kind).toBe('redundant')
    }
  })

  it('never pairs an agent against itself', () => {
    for (const e of seedEvents(NOW)) expect(e.a.agent).not.toBe(e.b.agent)
  })

  it('every timestamp is at or before now', () => {
    for (const e of seedEvents(NOW)) expect(e.ts).toBeLessThanOrEqual(NOW)
  })

  it('has no duplicate ids', () => {
    const ids = seedEvents(NOW).map(e => e.id)
    expect(new Set(ids).size).toBe(ids.length)
  })
})
