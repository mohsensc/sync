// Two fixes that only show up against a real git process, not canned
// porcelain text: gitapi.test.ts's fixtures can't reproduce them, so this
// file builds a throwaway repo on disk instead.
//
//  - task 4: `git ls-files` C-quotes any non-ASCII byte under git's default
//    core.quotepath (`"unicode-caf\303\251.txt"`, literal backslash-octal),
//    which never string-equals the real UTF-8 path a route's allowlist
//    check compares it against.
//  - task 3: canonicalNamesFor's `git log` has no maxBuffer, so a big
//    enough repo overflows it and the raw Node error text
//    ("stdout maxBuffer length exceeded") leaks straight into the JSON
//    response instead of the route's own honest failure shape.
//
// gitApiMiddleware's second (optional) argument exists for exactly this:
// nothing generates a 45,000-commit fixture in a unit test, but overriding
// maxBuffer down to a handful of bytes reproduces the same real
// ERR_CHILD_PROCESS_STDIO_MAXBUFFER on a two-commit repo instead.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { gitApiMiddleware } from '../gitapi.mjs'

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

const git = (dir: string, args: string[]) =>
  execFileSync('git', args, { cwd: dir, encoding: 'utf8' })

// Every commit needs its own identity — never touch global/repo git config
// (see this round's ground rules), so -c on each invocation instead.
const commit = (dir: string, msg: string) =>
  git(dir, ['-c', 'user.email=scratch@example.com', '-c', 'user.name=scratch', 'commit', '-q', '-m', msg])

const PLAIN = 'plain.txt'
const SPACED = 'with space.txt'
const UNICODE = 'unicode-café.txt'
const QUOTED = 'has"quote.txt'

describe('gitApiMiddleware against a scratch repo', () => {
  let dir = ''

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'gitapi-scratch-'))
    git(dir, ['init', '-q'])
    for (const name of [PLAIN, SPACED, UNICODE, QUOTED]) {
      writeFileSync(join(dir, name), 'hello\n')
    }
    git(dir, ['add', '-A'])
    commit(dir, 'add files')
  })

  afterAll(() => { if (dir) rmSync(dir, { recursive: true, force: true }) })

  it('sanity check: this repo actually reproduces git\'s own quoting (or the fix below is untested)', () => {
    const raw = git(dir, ['ls-files'])
    expect(raw).toContain('\\303\\251')      // "é" C-quoted, backslash-octal
    expect(raw).toContain('\\"quote.txt"')   // the literal quote, escaped
    expect(raw).toContain(SPACED)            // a space alone is NOT quoted —
    expect(raw).not.toContain(`"${SPACED}"`) // this case must already pass
  })

  const cases: [string, string][] = [
    ['a plain ascii filename', PLAIN],
    ['a filename with a space', SPACED],
    ['a filename with a literal quote', QUOTED],
    ['a unicode filename git C-quotes by default', UNICODE],
  ]

  for (const [label, name] of cases) {
    it(`stat: resolves ${label} as a tracked path`, async () => {
      const mw = gitApiMiddleware(dir)
      const r: any = await callMiddleware(mw, `/api/git/stat?path=${encodeURIComponent(name)}`)
      expect(r.json.ok).toBe(true)
      expect(r.json.commits).toBeGreaterThan(0)
    })

    it(`blame: resolves ${label} as a tracked path`, async () => {
      const mw = gitApiMiddleware(dir)
      const r: any = await callMiddleware(mw, `/api/git/blame?path=${encodeURIComponent(name)}`)
      expect(r.json.ok).toBe(true)
      expect(r.json.total).toBeGreaterThan(0)
    })
  }

  it('degrade: stat/log/recent/shortlog return an honest failure instead of leaking a maxBuffer error', async () => {
    // real overflow, not a mocked one: 8 bytes can't hold even one
    // "email<US>name" line, so canonicalNamesFor's own git log blows it on
    // this two-commit repo exactly the way it would on a 45,000-commit one.
    const mw = gitApiMiddleware(dir, { maxBuffer: 8 })
    const stat: any = await callMiddleware(mw, `/api/git/stat?path=${encodeURIComponent(PLAIN)}`)
    const log: any = await callMiddleware(mw, `/api/git/log?path=${encodeURIComponent(PLAIN)}`)
    const recent: any = await callMiddleware(mw, '/api/git/recent')
    const shortlog: any = await callMiddleware(mw, '/api/git/shortlog')
    // Exact reasons, not just "some non-maxBuffer string" — a loose
    // ok:false/no-"maxbuffer" check would pass just as happily if path
    // validation broke on this scratch repo instead, for a completely
    // different reason than the one this test exists to pin.
    expect(stat.json).toEqual({ ok: false, reason: 'stat unavailable' })
    expect(log.json).toEqual({ ok: false, reason: 'log unavailable' })
    expect(recent.json).toEqual({ ok: false, reason: 'recent history unavailable' })
    expect(shortlog.json).toEqual({ ok: false, reason: 'shortlog unavailable' })
    for (const r of [stat, log, recent, shortlog]) expect(r.status).toBe(200)
  })

  it('degrade: a generous maxBuffer (the default) does not trip the same routes on this repo', async () => {
    const mw = gitApiMiddleware(dir)
    const stat: any = await callMiddleware(mw, `/api/git/stat?path=${encodeURIComponent(PLAIN)}`)
    expect(stat.json.ok).toBe(true)
  })
})
