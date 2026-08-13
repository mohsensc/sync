import { describe, it, expect } from 'vitest'
import { hashString, hueForAuthor, colorForAuthor, parseRelativeAge, ageToX } from '../src/office/history-viz.js'

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
