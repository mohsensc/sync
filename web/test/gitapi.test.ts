import { describe, it, expect } from 'vitest'
import {
  ageDays,
  parseBlamePorcelain,
  parseLog,
  parseRecentLog,
  parseShortlog,
  parseCanonicalNames,
  mergeAuthorsByEmail,
  parseStatLog,
  parseChurnLog,
  parseNumstat,
  blameRangeArgs,
  sliceSourceLines,
  gitApiMiddleware,
} from '../gitapi.mjs'

// No @types/node in this project (see gitapi.d.ts), so this stays off
// node:path/node:url and leans on the documented invocation instead: tests
// always run as `cd web && pnpm test`, so '..' from here is the repo root.
const repoRoot = '..'

function callMiddleware(mw: any, url: string): Promise<{ status: number; json: any } | { next: true }> {
  return new Promise((resolve) => {
    const req = { url }
    const res: any = {
      statusCode: 0,
      headers: {} as Record<string, string>,
      setHeader(k: string, v: string) { this.headers[k] = v },
      end(body: string) { resolve({ status: this.statusCode, json: JSON.parse(body) }) },
    }
    mw(req, res, () => resolve({ next: true }))
  })
}

// --- canned porcelain, hand-shaped after real `git blame --porcelain` output ---
const SHA_A = 'aaaa000000000000000000000000000000000000'.slice(0, 40)
const SHA_B = 'bbbb000000000000000000000000000000000000'.slice(0, 40)

const CANNED_BLAME = [
  `${SHA_A} 1 1 3`,
  'author sara',
  'author-mail <sara@example.com>',
  'author-time 1700000000',
  'author-tz -0700',
  'committer sara',
  'committer-mail <sara@example.com>',
  'committer-time 1700000000',
  'committer-tz -0700',
  'summary first commit',
  'filename f.ts',
  '\tline one',
  `${SHA_A} 2 2`,
  '\tline two',
  `${SHA_B} 3 3 1`,
  'author dev',
  'author-mail <dev@example.com>',
  'author-time 1750000000',
  'author-tz -0700',
  'committer dev',
  'committer-mail <dev@example.com>',
  'committer-time 1750000000',
  'committer-tz -0700',
  'summary second commit',
  `previous ${SHA_A} f.ts`,
  'filename f.ts',
  '\tline three',
].join('\n') + '\n'

// two shas, same author-mail, different display name and time — the
// porcelain equivalent of the shortlog split-identity fixture above.
const CANNED_BLAME_SPLIT_IDENTITY = [
  `${SHA_A} 1 1 1`,
  'author mohsensc',
  'author-mail <mohsensarrafanc@ucla.edu>',
  'author-time 1700000000',
  'author-tz -0700',
  'committer mohsensc',
  'committer-mail <mohsensarrafanc@ucla.edu>',
  'committer-time 1700000000',
  'committer-tz -0700',
  'summary older commit, old spelling',
  'filename f.ts',
  '\tline one',
  `${SHA_B} 2 2 1`,
  'author Mohsen Sarrafan Chaharsoughi',
  'author-mail <mohsensarrafanc@ucla.edu>',
  'author-time 1750000000',
  'author-tz -0700',
  'committer Mohsen Sarrafan Chaharsoughi',
  'committer-mail <mohsensarrafanc@ucla.edu>',
  'committer-time 1750000000',
  'committer-tz -0700',
  'summary newer commit, new spelling',
  'filename f.ts',
  '\tline two',
].join('\n') + '\n'

const CANNED_SHORTLOG = [
  '    19\tsara <sara@example.com>',
  '     3\tdev <dev@example.com>',
].join('\n') + '\n'

// same shape as this repo's own history: one person, two name
// spellings, same inbox — the exact case the dedup exists for.
const CANNED_SHORTLOG_SPLIT_IDENTITY = [
  '   243\tmohsensc <mohsensarrafanc@ucla.edu>',
  '    35\tMohsen Sarrafan Chaharsoughi <mohsensarrafanc@ucla.edu>',
].join('\n') + '\n'

const US = '\x1f'

const CANNED_CANONICAL_NAMES = [
  ['mohsensarrafanc@ucla.edu', 'mohsensc'].join(US), // newest commit uses this spelling
  ['sara@example.com', 'sara'].join(US),
].join('\n') + '\n'

const CANNED_LOG = [
  ['abc1234', 'sara', '2 days ago', 'fix the thing'].join(US),
  ['def5678', 'dev', '3 weeks ago', 'add the thing'].join(US),
].join('\n') + '\n'

const CANNED_STAT_LOG = [
  ['sara', '1750000000', 'fix the thing'].join(US),
  ['dev', '1700000000', 'add the thing'].join(US),
].join('\n') + '\n'

// shaped after real `git log --numstat --format=%H` output: sha line,
// blank line, one numstat row per file touched, repeat per commit.
const CANNED_CHURN_LOG = [
  SHA_A,
  '',
  '17\t9\tf.ts',
  '',
  SHA_B,
  '',
  '5\t0\tf.ts',
  '3\t1\tother.ts',
  '',
].join('\n')

const CANNED_CHURN_LOG_WITH_BINARY = [
  SHA_A,
  '',
  '-\t-\timage.png',
  '4\t2\tf.ts',
  '',
].join('\n')

const CANNED_NUMSTAT = '6\t2\tf.ts\n'

describe('ageDays', () => {
  it('is zero for something that just happened', () => {
    const now = 1_700_000_000_000
    expect(ageDays(1_700_000_000, now)).toBe(0)
  })

  it('counts whole days back', () => {
    const now = 1_700_000_000_000
    expect(ageDays(1_700_000_000 - 3 * 86400, now)).toBe(3)
  })

  it('is null for a missing timestamp', () => {
    expect(ageDays(null as any)).toBeNull()
    expect(ageDays(undefined as any)).toBeNull()
  })
})

describe('parseBlamePorcelain', () => {
  it('rolls lines up by author, sorted by lines desc', () => {
    const now = 1_750_000_000_000
    const r = parseBlamePorcelain(CANNED_BLAME, now)
    expect(r.total).toBe(3)
    expect(r.owners).toEqual([
      { author: 'sara', lines: 2, share: 2 / 3 },
      { author: 'dev', lines: 1, share: 1 / 3 },
    ])
  })

  it('tracks newest/oldest line age from author-time', () => {
    const now = 1_750_000_000_000
    const r = parseBlamePorcelain(CANNED_BLAME, now)
    expect(r.newestLineAgeDays).toBe(0) // bbbb's author-time equals `now`
    expect(r.oldestLineAgeDays).toBeGreaterThan(r.newestLineAgeDays as number)
  })

  it('returns an empty-but-ok shape for an empty file', () => {
    const r = parseBlamePorcelain('')
    expect(r).toEqual({ total: 0, owners: [], newestLineAgeDays: null, oldestLineAgeDays: null })
  })

  it('merges two name spellings under one author-mail into one owner', () => {
    const r = parseBlamePorcelain(CANNED_BLAME_SPLIT_IDENTITY, 1_750_000_000_000)
    expect(r.owners).toEqual([
      { author: 'Mohsen Sarrafan Chaharsoughi', lines: 2, share: 1 },
    ])
  })

  it('omits the lines field unless includeLines is requested', () => {
    const r = parseBlamePorcelain(CANNED_BLAME, 1_750_000_000_000)
    expect(r.lines).toBeUndefined()
  })

  it('includes a per-line breakdown, canonical name and age, when asked', () => {
    const now = 1_750_000_000_000
    const r = parseBlamePorcelain(CANNED_BLAME, now, { includeLines: true })
    expect(r.lines).toEqual([
      { n: 1, author: 'sara', ageDays: ageDays(1700000000, now) },
      { n: 2, author: 'sara', ageDays: ageDays(1700000000, now) },
      { n: 3, author: 'dev', ageDays: ageDays(1750000000, now) },
    ])
  })

  it('dedups per-line author names to the canonical spelling too', () => {
    const r = parseBlamePorcelain(CANNED_BLAME_SPLIT_IDENTITY, 1_750_000_000_000, { includeLines: true })
    expect(r.lines).toEqual([
      { n: 1, author: 'Mohsen Sarrafan Chaharsoughi', ageDays: expect.any(Number) },
      { n: 2, author: 'Mohsen Sarrafan Chaharsoughi', ageDays: expect.any(Number) },
    ])
  })
})

describe('parseLog', () => {
  it('splits each entry on the unit separator', () => {
    expect(parseLog(CANNED_LOG)).toEqual([
      { sha: 'abc1234', author: 'sara', when: '2 days ago', subject: 'fix the thing' },
      { sha: 'def5678', author: 'dev', when: '3 weeks ago', subject: 'add the thing' },
    ])
  })

  it('returns an empty array for no history', () => {
    expect(parseLog('')).toEqual([])
    expect(parseLog('\n')).toEqual([])
  })
})

// canned `git log -n --format=\x01%h\x1f%ae\x1f%an\x1f%at\x1f%s --numstat`
// output, hand-shaped after the real thing (see the terminal check in this
// route's commit body): header, blank line, numstat rows, repeat.
const CANNED_RECENT = [
  '\x01aaa1111\x1fsara@example.com\x1fSara\x1f1700000000\x1ffix the thing',
  '',
  '3\t1\tfoo.ts',
  '\x01bbb2222\x1fdev@old.example.com\x1fDev Old Name\x1f1690000000\x1fadd the thing',
  '',
  '10\t0\tbar.ts',
  '5\t2\tbaz.ts',
  '\x01ccc3333\x1fsara@example.com\x1fSara\x1f1680000000\x1fmerge conflict binary blob',
  '',
  '-\t-\tbin.dat',
].join('\n')

describe('parseRecentLog', () => {
  it('pairs each header with its own numstat rows into a files count', () => {
    const now = 1700000000_000 + 1000 * 86400 // arbitrary "now" past every entry
    const entries = parseRecentLog(CANNED_RECENT, now)
    expect(entries).toEqual([
      { sha: 'aaa1111', author: 'Sara', subject: 'fix the thing', ageDays: expect.any(Number), files: 1 },
      { sha: 'bbb2222', author: 'Dev Old Name', subject: 'add the thing', ageDays: expect.any(Number), files: 2 },
      { sha: 'ccc3333', author: 'Sara', subject: 'merge conflict binary blob', ageDays: expect.any(Number), files: 1 },
    ])
  })

  it('resolves display name from canonicalNames by email, same dedup as shortlog', () => {
    const canonical = new Map([['dev@old.example.com', 'Dev New Name']])
    const entries = parseRecentLog(CANNED_RECENT, Date.now(), canonical)
    expect(entries[1].author).toBe('Dev New Name')
    // sara has no canonical override, falls back to the commit's own %an
    expect(entries[0].author).toBe('Sara')
  })

  it('a binary numstat row ("-\\t-\\t...") still counts as one touched file', () => {
    const entries = parseRecentLog(CANNED_RECENT)
    expect(entries[2].files).toBe(1)
  })

  it('returns an empty array for no history', () => {
    expect(parseRecentLog('')).toEqual([])
    expect(parseRecentLog('\n')).toEqual([])
  })

  it('handles a single commit with no trailing blank line', () => {
    const text = '\x01aaa1111\x1fsara@example.com\x1fSara\x1f1700000000\x1fonly commit\n2\t0\tf.ts'
    expect(parseRecentLog(text)).toEqual([
      { sha: 'aaa1111', author: 'Sara', subject: 'only commit', ageDays: expect.any(Number), files: 1 },
    ])
  })
})

describe('parseShortlog', () => {
  it('parses "<count>\\t<name> <email>" lines, whitespace and all', () => {
    expect(parseShortlog(CANNED_SHORTLOG)).toEqual([
      { author: 'sara', email: 'sara@example.com', commits: 19 },
      { author: 'dev', email: 'dev@example.com', commits: 3 },
    ])
  })

  it('returns an empty array for a directory with no commits', () => {
    expect(parseShortlog('')).toEqual([])
  })
})

describe('parseCanonicalNames', () => {
  it('keeps the first (newest) name seen per email', () => {
    const names = parseCanonicalNames(CANNED_CANONICAL_NAMES)
    expect(names.get('mohsensarrafanc@ucla.edu')).toBe('mohsensc')
    expect(names.get('sara@example.com')).toBe('sara')
  })

  it('is empty for no history', () => {
    expect(parseCanonicalNames('').size).toBe(0)
  })
})

describe('mergeAuthorsByEmail', () => {
  it('merges two name spellings under one email, summing counts', () => {
    const rows = parseShortlog(CANNED_SHORTLOG_SPLIT_IDENTITY)
    const names = parseCanonicalNames(CANNED_CANONICAL_NAMES)
    expect(mergeAuthorsByEmail(rows, names)).toEqual([
      { author: 'mohsensc', commits: 278 },
    ])
  })

  it('leaves distinct emails as distinct owners', () => {
    const rows = parseShortlog(CANNED_SHORTLOG)
    const names = parseCanonicalNames(CANNED_CANONICAL_NAMES)
    expect(mergeAuthorsByEmail(rows, names)).toEqual([
      { author: 'sara', commits: 19 },
      { author: 'dev', commits: 3 },
    ])
  })

  it('falls back to the row name when no canonical map is given', () => {
    const rows = parseShortlog(CANNED_SHORTLOG)
    expect(mergeAuthorsByEmail(rows, undefined)).toEqual([
      { author: 'sara', commits: 19 },
      { author: 'dev', commits: 3 },
    ])
  })
})

describe('parseStatLog', () => {
  it('rolls up commit count, author count, and last/first age', () => {
    const now = 1_750_000_000_000
    const r = parseStatLog(CANNED_STAT_LOG, now)
    expect(r).toEqual({
      commits: 2,
      authorCount: 2,
      lastAuthor: 'sara',
      lastAgeDays: 0,
      firstAgeDays: Math.floor((now - 1_700_000_000 * 1000) / 86400000),
      lastSummary: 'fix the thing',
    })
  })

  it('returns null for a file with no history', () => {
    expect(parseStatLog('')).toBeNull()
  })
})

describe('parseChurnLog', () => {
  it('counts commits and sums added/deleted across all numstat rows', () => {
    const r = parseChurnLog(CANNED_CHURN_LOG)
    expect(r).toEqual({ commits: 2, added: 17 + 5 + 3, deleted: 9 + 0 + 1 })
  })

  it('treats binary "-" rows as zero instead of NaN', () => {
    const r = parseChurnLog(CANNED_CHURN_LOG_WITH_BINARY)
    expect(r).toEqual({ commits: 1, added: 4, deleted: 2 })
  })

  it('is zero-commits for a path with no recent history', () => {
    expect(parseChurnLog('')).toEqual({ commits: 0, added: 0, deleted: 0 })
  })
})

describe('parseNumstat', () => {
  it('sums added/deleted with no commit lines to skip', () => {
    expect(parseNumstat(CANNED_NUMSTAT)).toEqual({ added: 6, deleted: 2 })
  })

  it('is zero for a clean working tree', () => {
    expect(parseNumstat('')).toEqual({ added: 0, deleted: 0 })
  })
})

describe('blameRangeArgs', () => {
  it('builds -L start,end when both are present and valid', () => {
    expect(blameRangeArgs('10', '20')).toEqual(['-L', '10,20'])
  })

  it('clamps into 1..500000', () => {
    expect(blameRangeArgs('0', '999999')).toEqual(['-L', '1,500000'])
  })

  it('falls back to whole-file when either value is missing', () => {
    expect(blameRangeArgs('10', null)).toEqual([])
    expect(blameRangeArgs(undefined, '20')).toEqual([])
    expect(blameRangeArgs(null, null)).toEqual([])
  })

  it('ignores malformed values rather than half-parsing them', () => {
    expect(blameRangeArgs('abc', '20')).toEqual([])
    expect(blameRangeArgs('10', '-5')).toEqual([])
    expect(blameRangeArgs('1.5', '20')).toEqual([])
  })
})

describe('sliceSourceLines', () => {
  const FILE_10_LINES = Array.from({ length: 10 }, (_, i) => `line ${i + 1}`).join('\n') + '\n'

  it('slices a plain range', () => {
    expect(sliceSourceLines(FILE_10_LINES, '3', '5')).toEqual({
      ok: true, lines: ['line 3', 'line 4', 'line 5'],
    })
  })

  it('defaults to the whole file when start/end are missing', () => {
    const r = sliceSourceLines(FILE_10_LINES, null, null)
    expect(r.ok).toBe(true)
    expect((r as any).lines.length).toBe(10)
  })

  it('caps a huge range at 200 lines', () => {
    const big = Array.from({ length: 1000 }, (_, i) => `line ${i + 1}`).join('\n') + '\n'
    const r = sliceSourceLines(big, '1', '1000')
    expect(r.ok).toBe(true)
    expect((r as any).lines.length).toBe(200)
    expect((r as any).lines[0]).toBe('line 1')
    expect((r as any).lines[199]).toBe('line 200')
  })

  it('rejects binary content instead of slicing garbage', () => {
    const r = sliceSourceLines('abc\x00def', '1', '1')
    expect(r).toEqual({ ok: false, reason: 'binary file' })
  })

  it('gives ok:false for an empty file', () => {
    expect(sliceSourceLines('', '1', '1')).toEqual({ ok: false, reason: 'empty file' })
  })

  it('gives ok:false when start is past the end of the file', () => {
    expect(sliceSourceLines(FILE_10_LINES, '50', '60')).toEqual({
      ok: false, reason: 'start beyond end of file',
    })
  })
})

// --- middleware, invoked directly against the real repo on disk ---

describe('gitApiMiddleware against the real repo', () => {
  const mw = gitApiMiddleware(repoRoot)
  const REAL_PATH = 'web/src/office/anim.js'
  const FAKE_PATH = 'web/src/office/does-not-exist.js'

  it('passes non-git-api requests through to next()', async () => {
    const r = await callMiddleware(mw, '/index.html')
    expect(r).toEqual({ next: true })
  })

  it('stat: gives plausible real numbers for a tracked path', async () => {
    const r: any = await callMiddleware(mw, `/api/git/stat?path=${encodeURIComponent(REAL_PATH)}`)
    expect(r.status).toBe(200)
    expect(r.json.ok).toBe(true)
    expect(r.json.commits).toBeGreaterThan(0)
    expect(r.json.authorCount).toBeGreaterThan(0)
    expect(typeof r.json.lastAuthor).toBe('string')
    expect(r.json.lastAgeDays).toBeGreaterThanOrEqual(0)
    expect(r.json.firstAgeDays).toBeGreaterThanOrEqual(r.json.lastAgeDays)
    expect(typeof r.json.lastSummary).toBe('string')
  })

  it('stat: gives ok:false for a made-up path', async () => {
    const r: any = await callMiddleware(mw, `/api/git/stat?path=${encodeURIComponent(FAKE_PATH)}`)
    expect(r.status).toBe(200)
    expect(r.json.ok).toBe(false)
    expect(typeof r.json.reason).toBe('string')
  })

  it('stat: rejects a flag-shaped path instead of handing it to git', async () => {
    const r: any = await callMiddleware(mw, '/api/git/stat?path=--upload-pack')
    expect(r.json).toEqual({ ok: false, reason: 'not a tracked path' })
  })

  it('blame: gives ownership bars for a tracked path', async () => {
    const r: any = await callMiddleware(mw, `/api/git/blame?path=${encodeURIComponent(REAL_PATH)}`)
    expect(r.json.ok).toBe(true)
    expect(r.json.total).toBeGreaterThan(0)
    expect(r.json.owners.length).toBeGreaterThan(0)
    const shareSum = r.json.owners.reduce((s: number, o: any) => s + o.share, 0)
    expect(shareSum).toBeCloseTo(1, 5)
  })

  it('blame: gives ok:false for a made-up path', async () => {
    const r: any = await callMiddleware(mw, `/api/git/blame?path=${encodeURIComponent(FAKE_PATH)}`)
    expect(r.json).toEqual({ ok: false, reason: 'not a tracked path' })
  })

  it('log: gives recent entries, newest first, capped by n', async () => {
    const r: any = await callMiddleware(mw, `/api/git/log?path=${encodeURIComponent(REAL_PATH)}&n=3`)
    expect(r.json.ok).toBe(true)
    expect(r.json.entries.length).toBeGreaterThan(0)
    expect(r.json.entries.length).toBeLessThanOrEqual(3)
    for (const e of r.json.entries) {
      expect(typeof e.sha).toBe('string')
      expect(typeof e.author).toBe('string')
      expect(typeof e.when).toBe('string')
      expect(typeof e.subject).toBe('string')
    }
  })

  it('log: gives ok:false for a made-up path', async () => {
    const r: any = await callMiddleware(mw, `/api/git/log?path=${encodeURIComponent(FAKE_PATH)}`)
    expect(r.json).toEqual({ ok: false, reason: 'not a tracked path' })
  })

  it('recent: gives repo-wide entries, newest first, capped by count', async () => {
    const r: any = await callMiddleware(mw, '/api/git/recent?count=4')
    expect(r.status).toBe(200)
    expect(r.json.ok).toBe(true)
    expect(r.json.entries.length).toBeGreaterThan(0)
    expect(r.json.entries.length).toBeLessThanOrEqual(4)
    for (const e of r.json.entries) {
      expect(typeof e.sha).toBe('string')
      expect(typeof e.author).toBe('string')
      expect(typeof e.subject).toBe('string')
      expect(e.ageDays === null || typeof e.ageDays === 'number').toBe(true)
      expect(typeof e.files).toBe('number')
      expect(e.files).toBeGreaterThan(0)
    }
  })

  it('recent: defaults count to 8 and clamps an out-of-range count to 30', async () => {
    const noCount: any = await callMiddleware(mw, '/api/git/recent')
    expect(noCount.json.entries.length).toBeLessThanOrEqual(8)
    const huge: any = await callMiddleware(mw, '/api/git/recent?count=999')
    expect(huge.json.entries.length).toBeLessThanOrEqual(30)
  })

  it('recent: dedups this repo\'s own split identity the same way shortlog does', async () => {
    const r: any = await callMiddleware(mw, '/api/git/recent?count=30')
    const names = new Set(r.json.entries.map((e: any) => e.author))
    expect([...names].filter((n) => n.toLowerCase().includes('mohsen')).length).toBeLessThanOrEqual(1)
  })

  it('shortlog: gives owners with shares summing to 1 for a real dir', async () => {
    const r: any = await callMiddleware(mw, '/api/git/shortlog?dir=web/src/office')
    expect(r.json.ok).toBe(true)
    expect(r.json.owners.length).toBeGreaterThan(0)
    const shareSum = r.json.owners.reduce((s: number, o: any) => s + o.share, 0)
    expect(shareSum).toBeCloseTo(1, 5)
  })

  it('shortlog: gives ok:false for a made-up dir', async () => {
    const r: any = await callMiddleware(mw, '/api/git/shortlog?dir=does/not/exist')
    expect(r.json).toEqual({ ok: false, reason: 'not a tracked dir' })
  })

  it('shortlog: dedups this repo\'s own split identity into one owner', async () => {
    // real regression case: this repo's history has "mohsensc" and
    // "Mohsen Sarrafan Chaharsoughi" as separate git-log identities that
    // share one email — before dedup, shortlog listed both as owners.
    const r: any = await callMiddleware(mw, '/api/git/shortlog?dir=web/src/office')
    expect(r.json.ok).toBe(true)
    const names = r.json.owners.map((o: any) => o.author)
    expect(names.filter((n: string) => n.toLowerCase().includes('mohsen')).length).toBeLessThanOrEqual(1)
  })

  it('blame: honors start/end to scope the porcelain call to a range', async () => {
    const r: any = await callMiddleware(
      mw, `/api/git/blame?path=${encodeURIComponent(REAL_PATH)}&start=1&end=5`
    )
    expect(r.json.ok).toBe(true)
    expect(r.json.total).toBeGreaterThan(0)
    expect(r.json.total).toBeLessThanOrEqual(5)
  })

  it('blame: ignores malformed start/end and blames the whole file', async () => {
    const whole: any = await callMiddleware(mw, `/api/git/blame?path=${encodeURIComponent(REAL_PATH)}`)
    const bogus: any = await callMiddleware(
      mw, `/api/git/blame?path=${encodeURIComponent(REAL_PATH)}&start=abc&end=5`
    )
    expect(bogus.json.total).toBe(whole.json.total)
  })

  it('churn: gives real nonzero numbers for a recently-edited path', async () => {
    // this file is under active development this round — real recent commits
    // with real added/deleted line counts, not a canned stub.
    const r: any = await callMiddleware(
      mw, `/api/git/churn?path=${encodeURIComponent('web/src/office/office.html')}`
    )
    expect(r.status).toBe(200)
    expect(r.json.ok).toBe(true)
    expect(r.json.recent.windowDays).toBe(14)
    expect(r.json.recent.commits).toBeGreaterThan(0)
    expect(r.json.recent.added).toBeGreaterThan(0)
    expect(typeof r.json.working.added).toBe('number')
    expect(typeof r.json.working.deleted).toBe('number')
  })

  it('churn: gives ok:false for a made-up path', async () => {
    const r: any = await callMiddleware(mw, `/api/git/churn?path=${encodeURIComponent(FAKE_PATH)}`)
    expect(r.json).toEqual({ ok: false, reason: 'not a tracked path' })
  })

  it('churn: rejects a flag-shaped path instead of handing it to git', async () => {
    const r: any = await callMiddleware(mw, '/api/git/churn?path=--upload-pack')
    expect(r.json).toEqual({ ok: false, reason: 'not a tracked path' })
  })

  it('blame: adds a lines[] breakdown when lines=1 and the range is small', async () => {
    const r: any = await callMiddleware(
      mw, `/api/git/blame?path=${encodeURIComponent(REAL_PATH)}&start=1&end=5&lines=1`
    )
    expect(r.json.ok).toBe(true)
    expect(Array.isArray(r.json.lines)).toBe(true)
    expect(r.json.lines.length).toBeGreaterThan(0)
    for (const row of r.json.lines) {
      expect(typeof row.n).toBe('number')
      expect(typeof row.author).toBe('string')
      expect(row.ageDays === null || typeof row.ageDays === 'number').toBe(true)
    }
  })

  it('blame: omits lines[] when lines=1 is missing (unchanged today behavior)', async () => {
    const r: any = await callMiddleware(
      mw, `/api/git/blame?path=${encodeURIComponent(REAL_PATH)}&start=1&end=5`
    )
    expect(r.json.ok).toBe(true)
    expect(r.json.lines).toBeUndefined()
  })

  it('blame: omits lines[] when the requested range is over 150 lines', async () => {
    const r: any = await callMiddleware(
      mw, `/api/git/blame?path=${encodeURIComponent(REAL_PATH)}&start=1&end=200&lines=1`
    )
    expect(r.json.ok).toBe(true)
    expect(r.json.lines).toBeUndefined()
  })

  it('blame: omits lines[] when lines=1 but no range is given', async () => {
    const r: any = await callMiddleware(mw, `/api/git/blame?path=${encodeURIComponent(REAL_PATH)}&lines=1`)
    expect(r.json.ok).toBe(true)
    expect(r.json.lines).toBeUndefined()
  })

  it('source: returns real source lines for a tracked path and range', async () => {
    const r: any = await callMiddleware(
      mw, `/api/git/source?path=${encodeURIComponent(REAL_PATH)}&start=1&end=3`
    )
    expect(r.json.ok).toBe(true)
    expect(r.json.lines.length).toBe(3)
    for (const line of r.json.lines) expect(typeof line).toBe('string')
  })

  it('source: gives ok:false for a made-up path', async () => {
    const r: any = await callMiddleware(mw, `/api/git/source?path=${encodeURIComponent(FAKE_PATH)}&start=1&end=3`)
    expect(r.json).toEqual({ ok: false, reason: 'not a tracked path' })
  })

  it('source: rejects a flag-shaped path instead of handing it to git', async () => {
    const r: any = await callMiddleware(mw, '/api/git/source?path=--upload-pack&start=1&end=3')
    expect(r.json).toEqual({ ok: false, reason: 'not a tracked path' })
  })

  it('source: caps a huge range at 200 lines', async () => {
    const r: any = await callMiddleware(
      mw, `/api/git/source?path=${encodeURIComponent(REAL_PATH)}&start=1&end=100000`
    )
    expect(r.json.ok).toBe(true)
    expect(r.json.lines.length).toBeLessThanOrEqual(200)
  })
})
