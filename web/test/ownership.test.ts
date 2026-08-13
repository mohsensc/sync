import { describe, it, expect } from 'vitest'
import { ownershipShare } from '../src/office/interact.js'

const blame = (owners: { author: string; lines: number; share: number }[]) =>
  ({ ok: true, total: owners.reduce((s, o) => s + o.lines, 0), owners })

describe('ownershipShare', () => {
  it('matches an identity that exactly equals an author', () => {
    const b = blame([{ author: 'mohsensc', lines: 80, share: 0.8 },
                      { author: 'someone-else', lines: 20, share: 0.2 }])
    const r = ownershipShare(b, 'mohsensc')
    expect(r).toEqual({ pct: 80, matched: true, name: 'mohsensc' })
  })

  it('matches loosely, either direction, case-insensitive', () => {
    const b = blame([{ author: 'Mohsen Sarrafan Chaharsoughi', lines: 40, share: 0.4 },
                      { author: 'mohsensc', lines: 60, share: 0.6 }])
    expect(ownershipShare(b, 'mohsensc')).toMatchObject({ matched: true, pct: 60 })
    expect(ownershipShare(b, 'MOHSENSC')).toMatchObject({ matched: true, pct: 60 })
  })

  it('degrades to the top owner, unmatched, when identity is a demo name', () => {
    const b = blame([{ author: 'mohsensc', lines: 210, share: 210 / 245 },
                      { author: 'Mohsen Sarrafan Chaharsoughi', lines: 35, share: 35 / 245 }])
    const r = ownershipShare(b, 'agent-3')
    expect(r?.matched).toBe(false)
    expect(r?.name).toBe('mohsensc')
    expect(r?.pct).toBe(86)
  })

  it('returns null on no blame, ok:false, or an empty owners list', () => {
    expect(ownershipShare(null, 'x')).toBe(null)
    expect(ownershipShare({ ok: false, reason: 'no blame available' }, 'x')).toBe(null)
    expect(ownershipShare({ ok: true, owners: [] }, 'x')).toBe(null)
  })

  it('never crashes on a missing or empty identity', () => {
    const b = blame([{ author: 'mohsensc', lines: 10, share: 1 }])
    expect(ownershipShare(b, undefined)).toMatchObject({ matched: false })
    expect(ownershipShare(b, '')).toMatchObject({ matched: false })
  })
})
