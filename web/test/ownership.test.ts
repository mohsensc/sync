import { describe, it, expect } from 'vitest'
import { ownershipShare } from '../src/office/interact.js'
import { isSingleOwner, singleOwnerSummary, pickDefaultVariant } from '../src/office/blamecard.js'

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

// ---------------------------------------------------------------------
// isSingleOwner / singleOwnerSummary — the blame card's single-owner
// collapse decision. Matters most once gitapi.mjs's email dedup lands
// (task 3): mohsensc and Mohsen Sarrafan Chaharsoughi merging into one
// identity turns most of this demo repo's files from "two owners" into
// exactly this case, and a full-width bar saying "100%" is the reviewer's
// confirmed bad state this exists to replace.
// ---------------------------------------------------------------------

describe('isSingleOwner', () => {
  it('is true for exactly one author with lines', () => {
    expect(isSingleOwner(blame([{ author: 'mohsensc', lines: 40, share: 1 }]))).toBe(true)
  })

  it('is false for two or more authors', () => {
    expect(isSingleOwner(blame([
      { author: 'mohsensc', lines: 10, share: 0.5 },
      { author: 'agentai', lines: 10, share: 0.5 },
    ]))).toBe(false)
  })

  it('is false for no history, ok:false, or an empty owners list', () => {
    expect(isSingleOwner(null)).toBe(false)
    expect(isSingleOwner({ ok: false, reason: 'no blame available' })).toBe(false)
    expect(isSingleOwner({ ok: true, total: 0, owners: [] })).toBe(false)
  })
})

describe('singleOwnerSummary', () => {
  it('names the sole author, total lines, and a readable age', () => {
    const s = singleOwnerSummary({
      ok: true, total: 245, newestLineAgeDays: 0, oldestLineAgeDays: 900,
      owners: [{ author: 'mohsensc', lines: 245, share: 1 }],
    })
    expect(s).toEqual({ author: 'mohsensc', total: 245, ageLabel: 'today' })
  })

  it('is null whenever isSingleOwner is false', () => {
    expect(singleOwnerSummary(blame([
      { author: 'a', lines: 1, share: 0.5 }, { author: 'b', lines: 1, share: 0.5 },
    ]))).toBeNull()
    expect(singleOwnerSummary({ ok: false })).toBeNull()
  })
})

// ---------------------------------------------------------------------
// pickDefaultVariant — the single-owner auto-pick that opens the blame
// card on 'story' instead of a dead one-color 'graphic' bar. Shares its
// definition of "dead bar" with isSingleOwner on purpose; this just
// checks the mapping, not the ownership logic itself (already covered
// above).
// ---------------------------------------------------------------------

describe('pickDefaultVariant', () => {
  it('picks story for a single-author file', () => {
    expect(pickDefaultVariant(blame([{ author: 'mohsensc', lines: 40, share: 1 }]))).toBe('story')
  })

  it('picks graphic for a multi-author file', () => {
    expect(pickDefaultVariant(blame([
      { author: 'mohsensc', lines: 10, share: 0.5 },
      { author: 'agentai', lines: 10, share: 0.5 },
    ]))).toBe('graphic')
  })

  it('picks graphic when there is no usable blame at all', () => {
    expect(pickDefaultVariant(null)).toBe('graphic')
    expect(pickDefaultVariant({ ok: false })).toBe('graphic')
  })
})
