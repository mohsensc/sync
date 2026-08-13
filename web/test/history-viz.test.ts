import { describe, it, expect } from 'vitest'
import {
  hashString, hueForAuthor, colorForAuthor, parseRelativeAge, ageToX, stackTimelinePositions,
} from '../src/office/history-viz.js'

describe('hashString / hueForAuthor', () => {
  it('is deterministic for the same input', () => {
    expect(hashString('mohsensc')).toBe(hashString('mohsensc'))
    expect(hueForAuthor('mohsensc')).toBe(hueForAuthor('mohsensc'))
  })

  it('spreads different names to different hues most of the time', () => {
    const hues = new Set(['mohsensc', 'agentai', 'a3', 'reception', 'unknown'].map(hueForAuthor))
    expect(hues.size).toBeGreaterThan(1)
  })

  it('stays inside 0..359', () => {
    for (const n of ['x', 'a much longer author name', '']) {
      const h = hueForAuthor(n)
      expect(h).toBeGreaterThanOrEqual(0)
      expect(h).toBeLessThan(360)
    }
  })
})

describe('colorForAuthor', () => {
  it('produces an hsl() string', () => {
    expect(colorForAuthor('mohsensc')).toMatch(/^hsl\(\d+ \d+% \d+%\)$/)
  })
})

describe('parseRelativeAge', () => {
  it('handles simple single-unit strings', () => {
    expect(parseRelativeAge('3 days ago')).toBeCloseTo(3)
    expect(parseRelativeAge('2 weeks ago')).toBeCloseTo(14)
    expect(parseRelativeAge('1 year ago')).toBeCloseTo(365)
  })

  it('handles compound strings git actually emits for old commits', () => {
    expect(parseRelativeAge('2 years, 1 month ago')).toBeCloseTo(2 * 365 + 30)
  })

  it('handles yesterday and right now', () => {
    expect(parseRelativeAge('yesterday')).toBe(1)
    expect(parseRelativeAge('right now')).toBe(0)
  })

  it('returns null for empty or unrecognisable input', () => {
    expect(parseRelativeAge('')).toBeNull()
    expect(parseRelativeAge(undefined as unknown as string)).toBeNull()
    expect(parseRelativeAge('some day')).toBeNull()
  })
})

describe('ageToX', () => {
  it('puts the newest commit (age 0) at the right edge', () => {
    expect(ageToX(0, 400)).toBeCloseTo(1)
  })

  it('puts the oldest commit at the left edge when age equals max', () => {
    expect(ageToX(400, 400)).toBeCloseTo(0)
  })

  it('clamps to 0..1 for out-of-range input', () => {
    expect(ageToX(-5, 100)).toBeLessThanOrEqual(1)
    expect(ageToX(500, 100)).toBeGreaterThanOrEqual(0)
  })
})

describe('stackTimelinePositions', () => {
  it('returns one entry per input age, same order', () => {
    const out = stackTimelinePositions([1, 2, 3], 3)
    expect(out).toHaveLength(3)
  })

  it('groups ages that land within slop of each other into one bucket', () => {
    // eight commits all "2 days ago" — ageToX(2, 400) is identical for
    // every one of them, exactly the collision the reviewer saw render
    // as a single dot for a 10-commit file
    const ages = Array.from({ length: 8 }, () => 2)
    const out = stackTimelinePositions(ages, 400)
    expect(out.every((o) => o.bucketSize === 8)).toBe(true)
    // positions within a bucket are unique 0..bucketSize-1, no two commits
    // assigned the same stack slot
    expect(new Set(out.map((o) => o.bucketPos)).size).toBe(8)
  })

  it('keeps well-separated ages in their own single-item buckets', () => {
    const out = stackTimelinePositions([0, 200, 400], 400)
    expect(out.every((o) => o.bucketSize === 1 && o.bucketPos === 0)).toBe(true)
  })

  it('does not let a long run of close-but-not-identical ages chain into one giant bucket', () => {
    // each age is slop-adjacent to its neighbour but the run spans far
    // more than slop end-to-end — anchoring on the bucket's first member
    // (not the previous item) should split this into more than one bucket
    const ages = Array.from({ length: 40 }, (_, i) => i * 2)
    const out = stackTimelinePositions(ages, 400)
    const sizes = new Set(out.map((o) => o.bucketSize))
    expect(sizes.size).toBeGreaterThan(1)
    expect(out.every((o) => o.bucketSize < 40)).toBe(true)
  })

  it('averages the bucket to one x position shared by every member', () => {
    const out = stackTimelinePositions([5, 5, 5], 400)
    expect(out[0].x).toBe(out[1].x)
    expect(out[1].x).toBe(out[2].x)
  })

  it('is empty for an empty input, never throws', () => {
    expect(stackTimelinePositions([], 100)).toEqual([])
    expect(stackTimelinePositions(undefined as unknown as number[], 100)).toEqual([])
  })
})
