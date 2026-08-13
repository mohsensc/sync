import { describe, it, expect } from 'vitest'
import { LiveDirector, regionFromMsg } from '../src/office/live.js'
import {
  hasUsableRegion, regionBlameUsable, regionGutterSegments, regionSummary,
} from '../src/office/blamecard.js'

// ---------------------------------------------------------------------
// live.js: region.start/region.end riding a presence frame through to
// LiveDirector.onPresence's returned info, without disturbing anything a
// consumer that never reads .start/.end would notice.
// ---------------------------------------------------------------------

function presence(over: Record<string, unknown> = {}) {
  return {
    type: 'presence', agent: 'a1', human: 'sara', verb: 'edit',
    region: { path: 'src/a.ts' }, rung: 0, ...over,
  }
}

describe('regionFromMsg', () => {
  it('reads a well-formed start/end off the region', () => {
    expect(regionFromMsg(presence({ region: { path: 'x', start: 10, end: 20 } })))
      .toEqual({ start: 10, end: 20 })
  })

  it('is null when the region has no range at all — today\'s whole-file frames', () => {
    expect(regionFromMsg(presence())).toBeNull()
  })

  it('is null when only one of start/end is present', () => {
    expect(regionFromMsg(presence({ region: { path: 'x', start: 10 } }))).toBeNull()
    expect(regionFromMsg(presence({ region: { path: 'x', end: 20 } }))).toBeNull()
  })

  it('is null when end does not come after start', () => {
    expect(regionFromMsg(presence({ region: { path: 'x', start: 20, end: 20 } }))).toBeNull()
    expect(regionFromMsg(presence({ region: { path: 'x', start: 20, end: 10 } }))).toBeNull()
  })

  it('is null on non-finite values rather than throwing', () => {
    expect(regionFromMsg(presence({ region: { path: 'x', start: 'a', end: 20 } }))).toBeNull()
    expect(regionFromMsg(presence({ region: { path: 'x', start: 10, end: NaN } }))).toBeNull()
  })

  it('is null with no region object on the message', () => {
    expect(regionFromMsg({ type: 'presence' })).toBeNull()
  })
})

describe('LiveDirector.onPresence — region plumbing', () => {
  it('carries start/end through to the returned info when present', () => {
    const d = new LiveDirector()
    const info = d.onPresence(presence({ region: { path: 'src/a.ts', start: 5, end: 40 } }), 0)
    expect(info.start).toBe(5)
    expect(info.end).toBe(40)
  })

  it('reports null start/end for a whole-file frame — unchanged default behaviour', () => {
    const d = new LiveDirector()
    const info = d.onPresence(presence(), 0)
    expect(info.start).toBeNull()
    expect(info.end).toBeNull()
  })

  it('does not let a bogus range leak through as a range', () => {
    const d = new LiveDirector()
    const info = d.onPresence(presence({ region: { path: 'src/a.ts', start: 40, end: 5 } }), 0)
    expect(info.start).toBeNull()
    expect(info.end).toBeNull()
  })

  it('tracks region independently per agent, second frame does not bleed into the first', () => {
    const d = new LiveDirector()
    const i1 = d.onPresence(presence({ agent: 'a1', region: { path: 'x', start: 1, end: 10 } }), 0)
    const i2 = d.onPresence(presence({ agent: 'a2', region: { path: 'y' } }), 0)
    expect(i1.start).toBe(1)
    expect(i2.start).toBeNull()
  })
})

// ---------------------------------------------------------------------
// blamecard.js: fallback logic and gutter grouping math, pure functions.
// ---------------------------------------------------------------------

describe('hasUsableRegion', () => {
  it('is true for an agent with a real path and a well-formed range', () => {
    expect(hasUsableRegion({ gitPath: 'a.ts', gitStart: 10, gitEnd: 20 })).toBe(true)
  })

  it('is false with no gitPath', () => {
    expect(hasUsableRegion({ gitStart: 10, gitEnd: 20 })).toBe(false)
  })

  it('is false with no range at all — the whole-file default', () => {
    expect(hasUsableRegion({ gitPath: 'a.ts' })).toBe(false)
  })

  it('is false when end does not exceed start', () => {
    expect(hasUsableRegion({ gitPath: 'a.ts', gitStart: 20, gitEnd: 20 })).toBe(false)
    expect(hasUsableRegion({ gitPath: 'a.ts', gitStart: 20, gitEnd: 5 })).toBe(false)
  })

  it('is false on a null/undefined agent', () => {
    expect(hasUsableRegion(null)).toBe(false)
    expect(hasUsableRegion(undefined)).toBe(false)
  })
})

describe('regionBlameUsable — the fallback-to-whole-file gate', () => {
  it('is true for an ok response with at least one line', () => {
    expect(regionBlameUsable({ ok: true, total: 3, owners: [] })).toBe(true)
  })

  it('is false for {ok:false} — a bogus range past EOF, same shape gitapi.mjs returns', () => {
    expect(regionBlameUsable({ ok: false, reason: 'no blame available' })).toBe(false)
  })

  it('is false for an ok response with zero lines (empty range)', () => {
    expect(regionBlameUsable({ ok: true, total: 0, owners: [] })).toBe(false)
  })

  it('is false for null/undefined', () => {
    expect(regionBlameUsable(null)).toBe(false)
    expect(regionBlameUsable(undefined)).toBe(false)
  })
})

describe('regionGutterSegments', () => {
  const blame = {
    ok: true, total: 14, owners: [
      { author: 'mohsensc', lines: 11, share: 11 / 14 },
      { author: 'agentai', lines: 3, share: 3 / 14 },
    ],
  }

  it('emits one segment per author, biggest first (owners already sorted by parseBlamePorcelain)', () => {
    const segs = regionGutterSegments(blame)
    expect(segs.map((s) => s.author)).toEqual(['mohsensc', 'agentai'])
  })

  it('rounds share to a whole percent', () => {
    const segs = regionGutterSegments(blame)
    expect(segs[0].pct).toBe(79) // 11/14 -> 78.57 -> 79
    expect(segs[1].pct).toBe(21)
  })

  it('flags the segment matching the agent as self, by role or name', () => {
    const segs = regionGutterSegments(blame, { role: 'mohsensc' })
    expect(segs.find((s) => s.author === 'mohsensc')!.self).toBe(true)
    expect(segs.find((s) => s.author === 'agentai')!.self).toBe(false)
  })

  it('is an empty array when the region blame is not usable', () => {
    expect(regionGutterSegments({ ok: false })).toEqual([])
    expect(regionGutterSegments(null)).toEqual([])
  })
})

describe('regionSummary', () => {
  it('names the top author, their share, and the newest line age', () => {
    const s = regionSummary({
      ok: true, total: 14, newestLineAgeDays: 0, oldestLineAgeDays: 12,
      owners: [
        { author: 'mohsensc', lines: 11, share: 11 / 14 },
        { author: 'agentai', lines: 3, share: 3 / 14 },
      ],
    })
    expect(s).toMatchObject({ total: 14, topAuthor: 'mohsensc', topPct: 79, multiAuthor: true, ageLabel: 'today' })
  })

  it('flags multiAuthor false for a single owner', () => {
    const s = regionSummary({
      ok: true, total: 5, newestLineAgeDays: 2, oldestLineAgeDays: 2,
      owners: [{ author: 'solo', lines: 5, share: 1 }],
    })
    expect(s!.multiAuthor).toBe(false)
  })

  it('formats age in a readable bucket: days, months, years', () => {
    const at = (days: number) => regionSummary({
      ok: true, total: 1, newestLineAgeDays: days, oldestLineAgeDays: days,
      owners: [{ author: 'x', lines: 1, share: 1 }],
    })!.ageLabel
    expect(at(0)).toBe('today')
    expect(at(1)).toBe('1 day')
    expect(at(9)).toBe('9 days')
    expect(at(60)).toBe('2 months')
    expect(at(400)).toBe('1 years')
  })

  it('is null when there is nothing usable to summarise', () => {
    expect(regionSummary({ ok: false })).toBeNull()
    expect(regionSummary({ ok: true, total: 0, owners: [] })).toBeNull()
  })
})
