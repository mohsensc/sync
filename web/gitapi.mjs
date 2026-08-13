// Dev-only /api/git/* endpoints: real git data for the office scene.
//
// office/*.js runs unbundled straight in the browser and can't shell out to
// git itself, so this is the seam — a vite dev-server middleware (see
// vite.config.js) that shells out on the server side and hands back JSON.
// Never shipped, never reachable outside `pnpm dev`.
//
// Every `path`/`dir` query param is checked against `git ls-files` before it
// ever reaches execFile, so nothing that isn't an actual tracked path in
// this repo can land in a git argv (rules out `--upload-pack`-style fakes).
// Shell-out is always `execFile('git', [...args])` — never a shell string.

import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const execFileP = promisify(execFile)
const US = '\x1f' // unit separator: git's own field delimiter, never appears in a subject line
const DAY_MS = 24 * 60 * 60 * 1000

export function ageDays(epochSeconds, now = Date.now()) {
  if (epochSeconds == null || Number.isNaN(epochSeconds)) return null
  return Math.max(0, Math.floor((now - epochSeconds * 1000) / DAY_MS))
}

// ---------------------------------------------------------------------
// Parsers. Pure functions: raw git stdout in, plain data out. No process
// spawning in here, so these are the part that's cheap to unit-test.
// ---------------------------------------------------------------------

// `git blame --porcelain` emits one header line per source line
// (`<sha> <origline> <finalline> [<groupsize>]`), followed by a full
// metadata block (author, author-time, ...) the first time a sha is seen
// and nothing but the header + tab-content line on repeats. Track sha ->
// {author, time} as we go and count one line per header line seen.
export function parseBlamePorcelain(text, now = Date.now()) {
  const lines = text.split('\n')
  const meta = new Map() // sha -> { author, time }
  const perLineSha = []
  let i = 0
  while (i < lines.length) {
    const header = /^([0-9a-f]{40}) \d+ \d+(?: \d+)?$/.exec(lines[i])
    if (!header) { i++; continue }
    const sha = header[1]
    i++
    while (i < lines.length && !lines[i].startsWith('\t')) {
      const l = lines[i]
      if (l.startsWith('author ')) {
        meta.set(sha, { ...(meta.get(sha) || {}), author: l.slice('author '.length) })
      } else if (l.startsWith('author-time ')) {
        meta.set(sha, { ...(meta.get(sha) || {}), time: parseInt(l.slice('author-time '.length), 10) })
      }
      i++
    }
    perLineSha.push(sha)
    i++ // consume the tab-prefixed content line (or EOF)
  }

  const total = perLineSha.length
  if (total === 0) {
    return { total: 0, owners: [], newestLineAgeDays: null, oldestLineAgeDays: null }
  }

  const byAuthor = new Map()
  let newestTime = -Infinity
  let oldestTime = Infinity
  for (const sha of perLineSha) {
    const m = meta.get(sha) || {}
    const author = m.author || 'unknown'
    byAuthor.set(author, (byAuthor.get(author) || 0) + 1)
    if (typeof m.time === 'number') {
      if (m.time > newestTime) newestTime = m.time
      if (m.time < oldestTime) oldestTime = m.time
    }
  }

  const owners = [...byAuthor.entries()]
    .map(([author, lines]) => ({ author, lines, share: lines / total }))
    .sort((a, b) => b.lines - a.lines)

  return {
    total,
    owners,
    newestLineAgeDays: Number.isFinite(newestTime) ? ageDays(newestTime, now) : null,
    oldestLineAgeDays: Number.isFinite(oldestTime) ? ageDays(oldestTime, now) : null,
  }
}

// `git log --follow -n <n> --date=relative --format=%h<US>%an<US>%ad<US>%s`
export function parseLog(text) {
  if (!text.trim()) return []
  return text.split('\n').filter(Boolean).map((line) => {
    const [sha, author, when, ...rest] = line.split(US)
    return { sha, author, when, subject: rest.join(US) }
  })
}

// `git shortlog -sn` — "  <count>\t<name>" per line. Share is left to the
// caller, since that needs the total across the whole result set.
export function parseShortlog(text) {
  if (!text.trim()) return []
  const owners = []
  for (const line of text.split('\n')) {
    const m = /^\s*(\d+)\t(.+)$/.exec(line)
    if (!m) continue
    owners.push({ author: m[2], commits: parseInt(m[1], 10) })
  }
  return owners
}

// `git log --follow --format=%an<US>%at<US>%s` (newest first, no -n cap).
export function parseStatLog(text, now = Date.now()) {
  const rows = text.split('\n').filter(Boolean).map((line) => {
    const [author, at, ...rest] = line.split(US)
    return { author, at: parseInt(at, 10), subject: rest.join(US) }
  })
  if (rows.length === 0) return null
  const authors = new Set(rows.map((r) => r.author))
  const newest = rows[0]
  const oldest = rows[rows.length - 1]
  return {
    commits: rows.length,
    authorCount: authors.size,
    lastAuthor: newest.author,
    lastAgeDays: ageDays(newest.at, now),
    firstAgeDays: ageDays(oldest.at, now),
    lastSummary: newest.subject,
  }
}

// `git log --since=<n>.days --numstat --format=%H -- <path>` — one commit
// sha line per commit, then a blank line, then zero or more
// `<added>\t<deleted>\t<path>` numstat rows (one per file the commit
// touched). Binary files print `-` in place of a number; treated as 0 so a
// binary-heavy commit doesn't turn the sum into NaN.
const SHA_LINE = /^[0-9a-f]{40}$/
const NUMSTAT_LINE = /^(\d+|-)\t(\d+|-)\t.+$/

function sumNumstat(text) {
  let added = 0
  let deleted = 0
  for (const line of text.split('\n')) {
    const m = NUMSTAT_LINE.exec(line)
    if (!m) continue
    added += m[1] === '-' ? 0 : parseInt(m[1], 10)
    deleted += m[2] === '-' ? 0 : parseInt(m[2], 10)
  }
  return { added, deleted }
}

export function parseChurnLog(text) {
  let commits = 0
  for (const line of text.split('\n')) {
    if (SHA_LINE.test(line)) commits++
  }
  return { commits, ...sumNumstat(text) }
}

// `git diff --numstat HEAD -- <path>` — uncommitted churn, same numstat row
// shape, no sha lines since it's a single working-tree diff.
export function parseNumstat(text) {
  return sumNumstat(text)
}

// start/end from query params, both optional. Clamp into git's own line
// range (git rejects 0 and negative starts), ignore anything that isn't a
// plain non-negative integer rather than half-parsing it — malformed input
// falls back to whole-file blame, same as no range at all.
function clampLine(raw) {
  if (raw == null) return null
  const s = String(raw).trim()
  if (!/^\d+$/.test(s)) return null
  return Math.min(500000, Math.max(1, parseInt(s, 10)))
}

export function blameRangeArgs(startRaw, endRaw) {
  const start = clampLine(startRaw)
  const end = clampLine(endRaw)
  if (start == null || end == null) return []
  return ['-L', `${start},${end}`]
}

// ---------------------------------------------------------------------
// Path/dir validation. The allowlist is "actually a tracked path in this
// repo right now" — nothing else gets near execFile's argv.
// ---------------------------------------------------------------------

async function trackedFiles(repoRoot) {
  const { stdout } = await execFileP('git', ['ls-files'], { cwd: repoRoot })
  return stdout.split('\n').filter(Boolean)
}

function isTrackedPath(p, files) {
  return typeof p === 'string' && p.length > 0 && files.includes(p)
}

function isTrackedDir(d, files) {
  if (d === '' || d === '.') return true // whole-repo shortlog
  if (typeof d !== 'string' || d.length === 0) return false
  const prefix = d.endsWith('/') ? d : d + '/'
  return files.some((f) => f.startsWith(prefix))
}

function sendJson(res, body) {
  res.statusCode = 200 // always 200 — failure is a shape in the body, not a status code
  res.setHeader('Content-Type', 'application/json')
  res.end(JSON.stringify(body))
}

// ---------------------------------------------------------------------
// Middleware
// ---------------------------------------------------------------------

export function gitApiMiddleware(repoRoot) {
  return async function handler(req, res, next) {
    const url = new URL(req.url, 'http://localhost')
    if (!url.pathname.startsWith('/api/git/')) return next()

    const route = url.pathname.slice('/api/git/'.length)

    try {
      const files = await trackedFiles(repoRoot)

      if (route === 'stat') {
        const p = url.searchParams.get('path')
        if (!isTrackedPath(p, files)) return sendJson(res, { ok: false, reason: 'not a tracked path' })
        const { stdout } = await execFileP(
          'git', ['log', '--follow', `--format=%an${US}%at${US}%s`, '--', p],
          { cwd: repoRoot }
        )
        const stat = parseStatLog(stdout)
        if (!stat) return sendJson(res, { ok: false, reason: 'no history' })
        return sendJson(res, { ok: true, ...stat })
      }

      if (route === 'blame') {
        const p = url.searchParams.get('path')
        if (!isTrackedPath(p, files)) return sendJson(res, { ok: false, reason: 'not a tracked path' })
        const rangeArgs = blameRangeArgs(url.searchParams.get('start'), url.searchParams.get('end'))
        try {
          const { stdout } = await execFileP(
            'git', ['blame', '--porcelain', ...rangeArgs, '--', p], { cwd: repoRoot }
          )
          return sendJson(res, { ok: true, ...parseBlamePorcelain(stdout) })
        } catch {
          // untracked, binary, or empty file — git blame exits non-zero for
          // all of these. Design for it, don't special-case it. A bogus
          // range (start past EOF) also lands here; same fallback.
          return sendJson(res, { ok: false, reason: 'no blame available' })
        }
      }

      if (route === 'churn') {
        const p = url.searchParams.get('path')
        if (!isTrackedPath(p, files)) return sendJson(res, { ok: false, reason: 'not a tracked path' })
        const windowDays = 14
        const [recentLog, workingDiff] = await Promise.all([
          execFileP(
            'git',
            ['log', `--since=${windowDays}.days`, '--numstat', '--format=%H', '--', p],
            { cwd: repoRoot }
          ),
          // uncommitted churn — what an agent is literally doing right now
          execFileP('git', ['diff', '--numstat', 'HEAD', '--', p], { cwd: repoRoot }),
        ])
        return sendJson(res, {
          ok: true,
          recent: { ...parseChurnLog(recentLog.stdout), windowDays },
          working: parseNumstat(workingDiff.stdout),
        })
      }

      if (route === 'log') {
        const p = url.searchParams.get('path')
        const n = Math.max(1, Math.min(50, parseInt(url.searchParams.get('n') || '8', 10) || 8))
        if (!isTrackedPath(p, files)) return sendJson(res, { ok: false, reason: 'not a tracked path' })
        const { stdout } = await execFileP(
          'git',
          ['log', '--follow', `-${n}`, '--date=relative', `--format=%h${US}%an${US}%ad${US}%s`, '--', p],
          { cwd: repoRoot }
        )
        return sendJson(res, { ok: true, entries: parseLog(stdout) })
      }

      if (route === 'shortlog') {
        const d = url.searchParams.get('dir') || ''
        if (!isTrackedDir(d, files)) return sendJson(res, { ok: false, reason: 'not a tracked dir' })
        const args = d === '' || d === '.' ? ['shortlog', '-sn', 'HEAD'] : ['shortlog', '-sn', 'HEAD', '--', d]
        const { stdout } = await execFileP('git', args, { cwd: repoRoot })
        const owners = parseShortlog(stdout)
        const total = owners.reduce((sum, o) => sum + o.commits, 0)
        return sendJson(res, {
          ok: true,
          owners: owners.map((o) => ({ ...o, share: total > 0 ? o.commits / total : 0 })),
        })
      }

      return sendJson(res, { ok: false, reason: 'unknown endpoint' })
    } catch (err) {
      return sendJson(res, { ok: false, reason: String((err && err.message) || err) })
    }
  }
}
