import { describe, it, expect } from 'vitest'
import { SPINE, spineFor, layoutShelf, spineOffset, shelfWidth } from '../src/office/histshelf.js'
import { colorForAuthor } from '../src/office/history-viz.js'

const entry = (over: Partial<{ sha: string; author: string; when: string; subject: string }> = {}) =>
  ({ sha: 'abc1234', author: 'mohsensc', when: '3 days ago', subject: 'fix thing', ...over })

describe('layoutShelf — empty and single-commit degrade', () => {
  it('renders nothing for zero commits, not an empty shelf', () => {
    expect(layoutShelf([])).toMatchObject({ empty: true, single: false, spines: [], count: 0 })
  })

  it('treats null/undefined entries the same as empty', () => {
    expect(layoutShelf(null)).toMatchObject({ empty: true, spines: [] })
    expect(layoutShelf(undefined)).toMatchObject({ empty: true, spines: [] })
  })

  it('flags exactly one commit as the dusty-tome case, not a normal row', () => {
    const l = layoutShelf([entry()])
    expect(l.empty).toBe(false)
    expect(l.single).toBe(true)
    expect(l.spines).toHaveLength(1)
  })

  it('is a normal row from two commits up', () => {
    const l = layoutShelf([entry(), entry({ sha: 'def', when: '1 year ago' })])
    expect(l.single).toBe(false)
    expect(l.spines).toHaveLength(2)
  })
})

describe('layoutShelf — caps and ordering', () => {
  it('caps at maxSpines and keeps the newest-first order entries arrive in', () => {
    const entries = Array.from({ length: 20 }, (_, i) => entry({ sha: `c${i}`, when: `${i} days ago` }))
    const l = layoutShelf(entries)
    expect(l.spines).toHaveLength(SPINE.maxSpines)
    expect(l.spines[0].sha).toBe('c0')
    expect(l.spines.map(s => s.index)).toEqual([...Array(SPINE.maxSpines).keys()])
  })

  it('honours a custom maxSpines', () => {
    const entries = Array.from({ length: 5 }, (_, i) => entry({ sha: `c${i}` }))
    expect(layoutShelf(entries, { maxSpines: 3 }).spines).toHaveLength(3)
  })
})

describe('spineFor — age mapping', () => {
  it('gives the newest commit in a batch the tallest, most-leaning spine', () => {
    const s = spineFor(entry({ when: 'right now' }), 400)
    expect(s.t).toBeCloseTo(1)
    expect(s.height).toBeCloseTo(SPINE.maxHeight)
    expect(s.lean).toBeCloseTo(SPINE.maxLean)
  })

  it('gives the oldest commit in a batch the shortest, most-upright spine', () => {
    const s = spineFor(entry({ when: '400 days ago' }), 400)
    expect(s.t).toBeCloseTo(0, 1)
    expect(s.height).toBeCloseTo(SPINE.minHeight, 1)
    expect(s.lean).toBeCloseTo(0, 1)
  })

  it('height always stays within the configured band', () => {
    for (const when of ['right now', '3 hours ago', '2 weeks ago', '2 years, 1 month ago']) {
      const s = spineFor(entry({ when }), 900)
      expect(s.height).toBeGreaterThanOrEqual(SPINE.minHeight - 1e-9)
      expect(s.height).toBeLessThanOrEqual(SPINE.maxHeight + 1e-9)
    }
  })

  it('falls back to maxDays (age 0-ish -> mid/near-newest) when the date string is unparseable', () => {
    const s = spineFor(entry({ when: 'some day' }), 400)
    // parseRelativeAge returns null -> ageToX(null, max) treats it as 0 (Math.max(0, days ?? 0))
    expect(s.ageDays).toBeNull()
    expect(s.t).toBeCloseTo(1)
  })

  it('defaults a missing author to "unknown" rather than throwing', () => {
    const s = spineFor({ sha: 'x', when: '1 day ago' }, 30)
    expect(s.author).toBe('unknown')
    expect(s.color).toBe(colorForAuthor('unknown'))
  })
})

describe('spineOffset / shelfWidth', () => {
  it('places spine 0 at the near end and grows linearly with spacing', () => {
    expect(spineOffset(0)).toBe(0)
    expect(spineOffset(3)).toBeCloseTo(3 * SPINE.spacing)
  })

  it('sums to the full row width for a normal layout', () => {
    const l = layoutShelf([entry(), entry({ sha: 'b' }), entry({ sha: 'c' })])
    expect(shelfWidth(l)).toBeCloseTo(3 * SPINE.spacing)
  })

  it('is zero for empty or single-commit layouts (no row to size)', () => {
    expect(shelfWidth(layoutShelf([]))).toBe(0)
    expect(shelfWidth(layoutShelf([entry()]))).toBe(0)
  })
})

describe('author colour stability', () => {
  it('is deterministic across repeated calls, same as history-viz relies on', () => {
    const a = spineFor(entry({ author: 'agentai' }), 30)
    const b = spineFor(entry({ author: 'agentai' }), 30)
    expect(a.color).toBe(b.color)
    expect(a.color).toBe(colorForAuthor('agentai'))
  })

  it('gives different authors different colours most of the time', () => {
    const names = ['mohsensc', 'agentai', 'rae', 'kade', 'unknown']
    const colors = new Set(names.map(n => spineFor(entry({ author: n }), 30).color))
    expect(colors.size).toBeGreaterThan(1)
  })
})
