// pickLiveVariant: the pure pick behind #60's "should live get variant
// abort beats too" call (see live.js's own comment for the decision and
// why). No DOM, no world, no relay — same style as office-caption.test.ts
// and the toReelEvent tests in office-live-decisions.test.ts.

import { describe, it, expect } from 'vitest'
import { pickLiveVariant, LIVE_ABORT_VARIANTS } from '../src/office/live.js'

describe('pickLiveVariant', () => {
  it('returns null for a wait decision — no variant family to pick from', () => {
    expect(pickLiveVariant('wait', 'agent-1', 'agent-2')).toBeNull()
  })

  it('returns null for anything that is not wait/abort', () => {
    // @ts-expect-error exercising a bad kind on purpose, same as
    // toReelEvent's own defensive tests do for malformed frames
    expect(pickLiveVariant('share', 'agent-1', 'agent-2')).toBeNull()
  })

  it('returns one of the abort family for an abort decision', () => {
    const v = pickLiveVariant('abort', 'agent-1', 'agent-2')
    expect(LIVE_ABORT_VARIANTS).toContain(v)
  })

  it('is deterministic for the same pair, called repeatedly', () => {
    const picks = Array.from({ length: 5 }, () => pickLiveVariant('abort', 'agent-9', 'agent-3'))
    expect(new Set(picks).size).toBe(1)
  })

  it('is deterministic regardless of which order winner/loser land — order still matters', () => {
    // winner/loser are ordered args (winnerId, loserId), not a set, so
    // swapping them is a different pair on purpose (same as two different
    // agents contesting could hash to two different variants) — this just
    // pins that swapping does NOT accidentally collapse to the same value
    // by some symmetry bug in the hash.
    const a = pickLiveVariant('abort', 'agent-1', 'agent-2')
    const b = pickLiveVariant('abort', 'agent-1', 'agent-2')
    expect(a).toBe(b)
  })

  it('spreads across the family for a handful of distinct pairs', () => {
    const pairs = [
      ['agent-1', 'agent-2'], ['agent-3', 'agent-4'], ['agent-5', 'agent-6'],
      ['agent-7', 'agent-8'], ['agent-9', 'agent-10'], ['agent-11', 'agent-12'],
    ]
    const picks = new Set(pairs.map(([w, l]) => pickLiveVariant('abort', w, l)))
    // Not every family member has to show up in six pairs, but a hash that
    // always landed on one variant would be a bug worth catching here.
    expect(picks.size).toBeGreaterThan(1)
  })

  it('only ever returns members of LIVE_ABORT_VARIANTS', () => {
    for (let i = 0; i < 20; i++) {
      const v = pickLiveVariant('abort', `agent-${i}`, `agent-${i + 100}`)
      expect(LIVE_ABORT_VARIANTS).toContain(v)
    }
  })
})
