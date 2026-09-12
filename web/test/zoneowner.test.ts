import { describe, it, expect, vi, afterEach } from 'vitest'
import {
  HAIR_COLORS, hairFor, POSSESSIVE_SHARE, CONTESTED_MARGIN,
  pickOwnership, plaqueScale, rugSplit, flourishFor, ownerLine,
  attachZoneOwner,
} from '../src/office/zoneowner.js'

// -- colour parity with palette.ts's hairFor --------------------------------
// zoneowner.js re-hosts the hash because office/*.js can't import the .ts
// side. This is the actual contract: same string in, same swatch out, and
// the swatch list itself has to be palette.ts's HAIR_COLORS verbatim (same
// hexes, same order), or a human's hair and their zone plaque disagree.

describe('hairFor — parity with palette.ts', () => {
  it('matches palette.ts\'s HAIR_COLORS swatches exactly, in order', () => {
    expect(HAIR_COLORS).toEqual([
      '#D9714F', '#8A94A3', '#D6B45C', '#A5738C', '#B0674F', '#E8946C',
    ])
  })

  it('is deterministic for the same name', () => {
    expect(hairFor('mohsensc')).toBe(hairFor('mohsensc'))
  })

  it('reproduces palette.ts\'s multiply-by-31 hash by hand for a known string', () => {
    // hairFor('ab'): h = 0*31 + 97 = 97; h = 97*31 + 98 = 3105. 3105 % 6 = 3.
    expect(hairFor('ab')).toBe(HAIR_COLORS[3])
  })

  it('treats missing/empty input as the empty string (index 0)', () => {
    expect(hairFor('')).toBe(HAIR_COLORS[0])
    expect(hairFor(undefined as unknown as string)).toBe(HAIR_COLORS[0])
    expect(hairFor(null as unknown as string)).toBe(HAIR_COLORS[0])
  })
})

// -- pickOwnership ------------------------------------------------------

describe('pickOwnership — empty/malformed input', () => {
  it('returns null on ok:false', () => {
    expect(pickOwnership({ ok: false })).toBe(null)
  })
  it('returns null on an empty owners list (fresh dir, no history)', () => {
    expect(pickOwnership({ ok: true, owners: [] })).toBe(null)
  })
  it('returns null on a missing owners field or null/undefined body', () => {
    expect(pickOwnership({ ok: true } as never)).toBe(null)
    expect(pickOwnership(null)).toBe(null)
    expect(pickOwnership(undefined)).toBe(null)
  })
})

describe('pickOwnership — top/second picking', () => {
  it('picks the top author by commits and exposes their share', () => {
    const data = { ok: true, owners: [
      { author: 'sara', commits: 3, share: 0.25 },
      { author: 'mohsen', commits: 9, share: 0.75 },
    ] }
    const own = pickOwnership(data)!
    expect(own.top).toEqual({ author: 'mohsen', commits: 9, share: 0.75 })
    expect(own.second).toEqual({ author: 'sara', commits: 3, share: 0.25 })
    expect(own.authorCount).toBe(2)
  })

  it('leaves second null with a single-author shortlog', () => {
    const own = pickOwnership({ ok: true, owners: [{ author: 'mohsen', commits: 4, share: 1 }] })!
    expect(own.top.author).toBe('mohsen')
    expect(own.second).toBe(null)
    expect(own.possessive).toBe(true)
    expect(own.contested).toBe(false)
  })

  it('derives share from commits when the endpoint omits it', () => {
    const own = pickOwnership({ ok: true, owners: [
      { author: 'a', commits: 1 } as never,
      { author: 'b', commits: 3 } as never,
    ] })!
    expect(own.top.author).toBe('b')
    expect(own.top.share).toBeCloseTo(0.75)
    expect(own.second!.share).toBeCloseTo(0.25)
  })

  it('breaks a commit tie deterministically by author name, not input order', () => {
    const a = { ok: true, owners: [{ author: 'zed', commits: 5, share: 0.5 }, { author: 'ann', commits: 5, share: 0.5 }] }
    const b = { ok: true, owners: [{ author: 'ann', commits: 5, share: 0.5 }, { author: 'zed', commits: 5, share: 0.5 }] }
    expect(pickOwnership(a)!.top.author).toBe('ann')
    expect(pickOwnership(b)!.top.author).toBe('ann')
  })
})

describe('pickOwnership — possessive/contested thresholds', () => {
  it('flags possessive at exactly the threshold share', () => {
    const own = pickOwnership({ ok: true, owners: [
      { author: 'a', commits: 80, share: POSSESSIVE_SHARE },
      { author: 'b', commits: 20, share: 1 - POSSESSIVE_SHARE },
    ] })!
    expect(own.possessive).toBe(true)
  })

  it('does not flag possessive just under the threshold', () => {
    const own = pickOwnership({ ok: true, owners: [
      { author: 'a', commits: 79, share: 0.79 },
      { author: 'b', commits: 21, share: 0.21 },
    ] })!
    expect(own.possessive).toBe(false)
  })

  it('flags contested when top and second are within the margin', () => {
    const own = pickOwnership({ ok: true, owners: [
      { author: 'a', commits: 55, share: 0.55 },
      { author: 'b', commits: 45, share: 0.45 },
    ] })!
    expect(own.contested).toBe(true)
    expect(own.possessive).toBe(false)
  })

  it('is neither possessive nor contested in the wide middle ground', () => {
    const own = pickOwnership({ ok: true, owners: [
      { author: 'a', commits: 60, share: 0.6 },
      { author: 'b', commits: 40, share: 0.4 },
    ] })!
    expect(own.possessive).toBe(false)
    expect(own.contested).toBe(false)
  })

  it('is never contested with only one author, however small the share', () => {
    const own = pickOwnership({ ok: true, owners: [{ author: 'solo', commits: 1, share: 1 }] })!
    expect(own.contested).toBe(false)
  })
})

// -- flourishFor ----------------------------------------------------------

describe('flourishFor', () => {
  it('is null with no ownership data', () => {
    expect(flourishFor(null)).toBe(null)
  })
  it('is trophy when possessive', () => {
    expect(flourishFor({ possessive: true, contested: false } as never)).toBe('trophy')
  })
  it('is contested when contested and not possessive', () => {
    expect(flourishFor({ possessive: false, contested: true } as never)).toBe('contested')
  })
  it('is null in the wide middle ground', () => {
    expect(flourishFor({ possessive: false, contested: false } as never)).toBe(null)
  })
  it('prefers trophy if both were somehow true (possessive wins)', () => {
    expect(flourishFor({ possessive: true, contested: true } as never)).toBe('trophy')
  })

  // -- single-owner calm ------------------------------------------------
  // Post-dedup, a real single-committer repo is possessive:true on every
  // zone — the trophy would fire everywhere and mean nothing. authorCount
  // === 1 overrides possessive/contested either way.
  it('is null for a genuine single-owner zone even though possessive is also true', () => {
    const own = pickOwnership({ ok: true, owners: [{ author: 'mohsensc', commits: 40, share: 1 }] })
    expect(own!.authorCount).toBe(1)
    expect(own!.possessive).toBe(true)
    expect(flourishFor(own)).toBe(null)
  })
  it('is null for authorCount:1 even if the fixture also claims contested', () => {
    expect(flourishFor({ authorCount: 1, possessive: false, contested: true } as never)).toBe(null)
  })
})

// -- ownerLine ----------------------------------------------------------

describe('ownerLine', () => {
  it('is empty with no ownership data', () => {
    expect(ownerLine(null)).toBe('')
  })
  it('reads "all <name>" for a single-owner zone, no percentage — same voice zones.js uses', () => {
    const own = pickOwnership({ ok: true, owners: [{ author: 'mohsensc', commits: 12, share: 1 }] })
    expect(ownerLine(own)).toBe('all mohsensc')
  })
  it('reads a rounded percentage when there is a second author', () => {
    const own = pickOwnership({ ok: true, owners: [
      { author: 'a', commits: 3, share: 0.75 }, { author: 'b', commits: 1, share: 0.25 },
    ] })
    expect(ownerLine(own)).toBe('75% of this area')
  })
})

// -- plaqueScale ------------------------------------------------------------

describe('plaqueScale', () => {
  it('grows monotonically with share', () => {
    expect(plaqueScale(0.9)).toBeGreaterThan(plaqueScale(0.5))
    expect(plaqueScale(0.5)).toBeGreaterThan(plaqueScale(0.1))
  })
  it('is clamped to a sane range even for out-of-bounds input', () => {
    const lo = plaqueScale(-3), hi = plaqueScale(50)
    expect(lo).toBe(plaqueScale(0))
    expect(hi).toBe(plaqueScale(1))
  })
  it('falls back to a mid-size plaque for non-numeric share', () => {
    expect(plaqueScale(NaN)).toBe(plaqueScale(0.5))
    expect(plaqueScale(undefined)).toBe(plaqueScale(0.5))
  })
})

// -- rugSplit -----------------------------------------------------------

describe('rugSplit', () => {
  it('is a solid rug (no stripe) with no second author', () => {
    expect(rugSplit(pickOwnership({ ok: true, owners: [{ author: 'a', commits: 1, share: 1 }] }))).toEqual({ topFrac: 1, secondFrac: 0 })
    expect(rugSplit(null)).toEqual({ topFrac: 1, secondFrac: 0 })
  })

  it('always sums to 1', () => {
    const own = pickOwnership({ ok: true, owners: [
      { author: 'a', commits: 7, share: 0.7 }, { author: 'b', commits: 3, share: 0.3 },
    ] })
    const { topFrac, secondFrac } = rugSplit(own)
    expect(topFrac + secondFrac).toBeCloseTo(1)
  })

  it('floors the runner-up stripe so it is always visible', () => {
    const own = pickOwnership({ ok: true, owners: [
      { author: 'a', commits: 98, share: 0.98 }, { author: 'b', commits: 2, share: 0.02 },
    ] })
    expect(rugSplit(own).secondFrac).toBeGreaterThanOrEqual(0.12)
  })

  it('caps the runner-up stripe so it never eclipses the lead', () => {
    const own = pickOwnership({ ok: true, owners: [
      { author: 'a', commits: 51, share: 0.51 }, { author: 'b', commits: 49, share: 0.49 },
    ] })
    expect(rugSplit(own).secondFrac).toBeLessThanOrEqual(0.45)
  })
})

// -- attachZoneOwner: tick overlap guard (issue #166) -----------------------
// No jsdom/happy-dom in this project (see office-vcard.test.ts) — `document`
// is undefined by default. attachZoneOwner's render path calls
// document.createElement('canvas') to paint the rug/plaque texture, so this
// stubs just that one touchpoint rather than pulling in a browser DOM.

function fakeCanvasDocument() {
  const fillTextCalls: unknown[][] = []
  const ctx = new Proxy({}, {
    get(_t, prop) {
      if (prop === 'fillText') return (...args: unknown[]) => { fillTextCalls.push(args) }
      return () => {}
    },
    set() { return true },
  })
  const canvas = { width: 0, height: 0, getContext: () => ctx }
  return {
    document: { createElement: (tag: string) => (tag === 'canvas' ? canvas : {}) },
    fillTextCalls,
  }
}

function deferredFetch() {
  let resolve!: (data: unknown) => void
  const promise = new Promise<{ json(): Promise<unknown> }>((res) => {
    resolve = (data: unknown) => res({ json: () => Promise.resolve(data) })
  })
  return { promise, resolve }
}

const shortlogOf = (author: string) => ({ ok: true, owners: [{ author, commits: 1, share: 1 }] })

describe('attachZoneOwner — tick overlap guard', () => {
  const { document: fakeDoc, fillTextCalls } = fakeCanvasDocument()
  vi.stubGlobal('document', fakeDoc)
  afterEach(() => { fillTextCalls.length = 0 })

  it('keeps the newer tick\'s result even when the older tick\'s fetch resolves last', async () => {
    const pending: ReturnType<typeof deferredFetch>[] = []
    const fetchFn = () => {
      const d = deferredFetch()
      pending.push(d)
      return d.promise
    }
    const zoneDirs = { reception: 'zones/reception' }
    const h = attachZoneOwner({ zoneDirs, fetchFn, intervalMs: 1e9 })

    // attachZoneOwner() kicks off tick A itself on construction.
    expect(pending.length).toBe(1)

    // tick B starts (a restart burst, or a slow-git overlap) before A resolves.
    const tickB = h.tick()
    expect(pending.length).toBe(2)

    // Resolve B (the newer poll) first, then A (the stale one) last — the
    // stale response landing later in wall time must not win.
    pending[1].resolve(shortlogOf('fresh-owner'))
    await tickB
    pending[0].resolve(shortlogOf('stale-owner'))
    // tick A's fetch chain (fetch -> .json() -> .catch -> await in tick())
    // runs several microtask hops deep; a macrotask flush drains all of
    // them regardless of hop count, unlike a fixed number of awaits.
    await new Promise((r) => setTimeout(r, 0))

    const names = fillTextCalls.map((args) => args[0])
    expect(names).toEqual(['fresh-owner'])
  })
})
