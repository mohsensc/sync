import { describe, it, expect } from 'vitest'
import {
  hashString, hueForAuthor, colorForAuthor, parseRelativeAge, ageToX, stackTimelinePositions,
  formatAge, agePhrase, composeStory,
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

describe('formatAge', () => {
  it('handles the boundary phrasing', () => {
    expect(formatAge(0)).toBe('today')
    expect(formatAge(1)).toBe('1 day')
    expect(formatAge(5)).toBe('5 days')
    expect(formatAge(60)).toBe('2 months')
    expect(formatAge(400)).toBe('1 years')
  })

  it('is null for null/undefined, never throws', () => {
    expect(formatAge(null)).toBeNull()
    expect(formatAge(undefined)).toBeNull()
  })
})

describe('agePhrase', () => {
  it('leaves "today" alone — it already reads as a complete phrase', () => {
    expect(agePhrase('today', 'ago')).toBe('today')
    expect(agePhrase('today', 'old')).toBe('today')
  })

  it('appends the suffix for every other bucket', () => {
    expect(agePhrase('1 day', 'ago')).toBe('1 day ago')
    expect(agePhrase('5 days', 'old')).toBe('5 days old')
    expect(agePhrase('2 months', 'ago')).toBe('2 months ago')
  })

  it('is null when there is no label to phrase', () => {
    expect(agePhrase(null, 'ago')).toBeNull()
    expect(agePhrase(undefined, 'ago')).toBeNull()
  })
})

describe('composeStory', () => {
  it('composes a multi-author sentence plus a busiest-stretch line', () => {
    const stat = { ok: true, commits: 10, authorCount: 2, lastAuthor: 'mohsensc', lastAgeDays: 2, firstAgeDays: 42, lastSummary: 'fix thing' }
    const blame = { ok: true, total: 200, owners: [
      { author: 'mohsensc', lines: 140, share: 0.7 },
      { author: 'agentai', lines: 60, share: 0.3 },
    ], newestLineAgeDays: 2, oldestLineAgeDays: 42 }
    const log = { ok: true, entries: [
      { sha: 'a', author: 'mohsensc', when: '2 days ago', subject: 'x' },
      { sha: 'b', author: 'mohsensc', when: '3 days ago', subject: 'y' },
      { sha: 'c', author: 'agentai', when: '10 days ago', subject: 'z' },
      { sha: 'd', author: 'mohsensc', when: '17 days ago', subject: 'w' },
      { sha: 'e', author: 'agentai', when: '24 days ago', subject: 'v' },
    ] }
    const { lines, commits } = composeStory(stat, log, blame)
    expect(lines[0]).toBe('Mostly mohsensc (70%) — 10 commits over 6 weeks, last touched 2 days ago.')
    expect(lines[1]).toMatch(/^Busiest stretch: 2 commits this week\.$/)
    expect(commits).toBe(log.entries)
  })

  it('drops the busiest line when nothing clusters', () => {
    const blame = { ok: true, total: 10, owners: [{ author: 'mohsensc', lines: 10, share: 1 }], newestLineAgeDays: 0, oldestLineAgeDays: 90 }
    const log = { ok: true, entries: [
      { sha: 'a', author: 'mohsensc', when: 'today', subject: 'x' },
      { sha: 'b', author: 'mohsensc', when: '30 days ago', subject: 'y' },
      { sha: 'c', author: 'mohsensc', when: '90 days ago', subject: 'z' },
    ] }
    const { lines } = composeStory({ ok: false }, log, blame)
    expect(lines).toHaveLength(1)
  })

  it('collapses to a plain sentence for a single-author file', () => {
    const stat = { ok: true, commits: 5, authorCount: 1, lastAuthor: 'mohsensc', lastAgeDays: 1, firstAgeDays: 20, lastSummary: 'fix' }
    const blame = { ok: true, total: 40, owners: [{ author: 'mohsensc', lines: 40, share: 1 }], newestLineAgeDays: 1, oldestLineAgeDays: 20 }
    const log = { ok: true, entries: [{ sha: 'a', author: 'mohsensc', when: 'yesterday', subject: 'x' }] }
    const { lines } = composeStory(stat, log, blame)
    expect(lines[0]).toBe('Written entirely by mohsensc — 5 commits over 3 weeks, last touched 1 day ago.')
  })

  it('gives the single-commit case its own plain sentence, no "mostly"', () => {
    const stat = { ok: true, commits: 1, authorCount: 1, lastAuthor: 'mohsensc', lastAgeDays: 7, firstAgeDays: 7, lastSummary: 'first cut' }
    const blame = { ok: true, total: 12, owners: [{ author: 'mohsensc', lines: 12, share: 1 }], newestLineAgeDays: 7, oldestLineAgeDays: 7 }
    const log = { ok: true, entries: [{ sha: 'a', author: 'mohsensc', when: '1 week ago', subject: 'first cut' }] }
    const { lines } = composeStory(stat, log, blame)
    expect(lines).toEqual(['one commit, 7 days ago, mohsensc.'])
  })

  it('derives the single-commit sentence from log alone when stat failed', () => {
    const log = { ok: true, entries: [{ sha: 'a', author: 'rae', when: '3 days ago', subject: 'x' }] }
    const { lines } = composeStory({ ok: false }, log, { ok: false })
    expect(lines).toEqual(['one commit, 3 days ago, rae.'])
  })

  it('degrades to a single "no history" line when everything is empty', () => {
    expect(composeStory({ ok: false }, { ok: false }, { ok: false })).toEqual({ lines: ['no history here yet'], commits: [] })
    expect(composeStory(null, null, null)).toEqual({ lines: ['no history here yet'], commits: [] })
  })

  it('phrases "last touched today" without a dangling "ago" — the single most common case', () => {
    const stat = { ok: true, commits: 10, authorCount: 2, lastAuthor: 'mohsensc', lastAgeDays: 0, firstAgeDays: 42, lastSummary: 'fix thing' }
    const blame = { ok: true, total: 200, owners: [
      { author: 'mohsensc', lines: 140, share: 0.7 },
      { author: 'agentai', lines: 60, share: 0.3 },
    ] }
    const log = { ok: true, entries: [{ sha: 'a', author: 'mohsensc', when: 'today', subject: 'x' }] }
    const { lines } = composeStory(stat, log, blame)
    expect(lines[0]).toContain('last touched today')
    expect(lines[0]).not.toContain('today ago')
  })

  it('phrases the single-commit case as "today", not "today ago"', () => {
    const stat = { ok: true, commits: 1, authorCount: 1, lastAuthor: 'mohsensc', lastAgeDays: 0, firstAgeDays: 0, lastSummary: 'first cut' }
    const blame = { ok: true, total: 12, owners: [{ author: 'mohsensc', lines: 12, share: 1 }] }
    const log = { ok: true, entries: [{ sha: 'a', author: 'mohsensc', when: 'today', subject: 'first cut' }] }
    const { lines } = composeStory(stat, log, blame)
    expect(lines).toEqual(['one commit, today, mohsensc.'])
  })

  it('never throws on missing fields inside otherwise-ok responses', () => {
    const blame = { ok: true, total: 3, owners: [{ author: 'mohsensc' }] } // no share, no ages
    const log = { ok: true, entries: [{ sha: 'a' }] } // no author/when/subject
    expect(() => composeStory({ ok: true }, log, blame)).not.toThrow()
    const { lines } = composeStory({ ok: true }, log, blame)
    expect(lines.length).toBeGreaterThan(0)
  })
})
