import { describe, it, expect } from 'vitest'
import {
  ageDays,
  parseBlamePorcelain,
  parseLog,
  parseShortlog,
  parseStatLog,
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

const CANNED_SHORTLOG = [
  '    19\tmohsensc',
  '     3\tMohsen Sarrafan Chaharsoughi',
].join('\n') + '\n'

const US = '\x1f'
const CANNED_LOG = [
  ['abc1234', 'sara', '2 days ago', 'fix the thing'].join(US),
  ['def5678', 'dev', '3 weeks ago', 'add the thing'].join(US),
].join('\n') + '\n'

const CANNED_STAT_LOG = [
  ['sara', '1750000000', 'fix the thing'].join(US),
  ['dev', '1700000000', 'add the thing'].join(US),
].join('\n') + '\n'

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

describe('parseShortlog', () => {
  it('parses "<count>\\t<name>" lines, whitespace and all', () => {
    expect(parseShortlog(CANNED_SHORTLOG)).toEqual([
      { author: 'mohsensc', commits: 19 },
      { author: 'Mohsen Sarrafan Chaharsoughi', commits: 3 },
    ])
  })

  it('returns an empty array for a directory with no commits', () => {
    expect(parseShortlog('')).toEqual([])
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
})
