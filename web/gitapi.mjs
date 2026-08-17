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
// metadata block (author, author-mail, author-time, ...) the first time a
// sha is seen and nothing but the header + tab-content line on repeats.
// Track sha -> {author, mail, time} as we go and count one line per
// header line seen.
//
// Ownership is grouped by author-mail, not display name. This repo's own
// history has two spellings of one person (`mohsensc` and `Mohsen
// Sarrafan Chaharsoughi`, same inbox — a git config change mid-project),
// and a vault plaque or blame bar that lists them as two separate owners
// is just wrong. Pass `{ includeLines: true }` to also get a per-line
// breakdown (used by the region-blame gutter view) — capped by the
// caller, since a whole-file per-line dump isn't something the UI wants.
export function parseBlamePorcelain(text, now = Date.now(), opts = {}) {
  const includeLines = !!opts.includeLines
  // The same address -> display name map the recent and shortlog routes use.
  // Without it this function still dedupes by address, but names the person
  // from the newest line *in this file*, which is a different answer than the
  // one the zone plaque gives for the same human — one office showing
  // "mohsensc" on a blame card and "Mohsen Sarrafan Chaharsoughi" on a plaque,
  // at once. Repo-wide is the only scope where every surface agrees.
  const canonicalNames = opts.canonicalNames || null
  const lines = text.split('\n')
  const meta = new Map() // sha -> { author, mail, time }
  const perLine = [] // { sha, finalLine }
  let i = 0
  while (i < lines.length) {
    const header = /^([0-9a-f]{40}) \d+ (\d+)(?: \d+)?$/.exec(lines[i])
    if (!header) { i++; continue }
    const sha = header[1]
    const finalLine = parseInt(header[2], 10)
    i++
    while (i < lines.length && !lines[i].startsWith('\t')) {
      const l = lines[i]
      if (l.startsWith('author ')) {
        meta.set(sha, { ...(meta.get(sha) || {}), author: l.slice('author '.length) })
      } else if (l.startsWith('author-mail ')) {
        const mail = l.slice('author-mail '.length).replace(/^<|>$/g, '')
        meta.set(sha, { ...(meta.get(sha) || {}), mail })
      } else if (l.startsWith('author-time ')) {
        meta.set(sha, { ...(meta.get(sha) || {}), time: parseInt(l.slice('author-time '.length), 10) })
      }
      i++
    }
    perLine.push({ sha, finalLine })
    i++ // consume the tab-prefixed content line (or EOF)
  }

  const total = perLine.length
  if (total === 0) {
    return {
      total: 0, owners: [], newestLineAgeDays: null, oldestLineAgeDays: null,
      ...(includeLines ? { lines: [] } : {}),
    }
  }

  // mail -> { lines, name, latestTime }. Display name for a mail is the
  // name on the most-recent-by-author-time line seen for it, so a split
  // identity resolves to whichever spelling that person is using now.
  const byMail = new Map()
  let newestTime = -Infinity
  let oldestTime = Infinity
  for (const { sha } of perLine) {
    const m = meta.get(sha) || {}
    const mail = m.mail || m.author || 'unknown'
    const entry = byMail.get(mail) || { lines: 0, name: m.author || 'unknown', latestTime: -Infinity }
    entry.lines++
    if (typeof m.time === 'number' && m.time >= entry.latestTime) {
      entry.latestTime = m.time
      entry.name = m.author || entry.name
    }
    byMail.set(mail, entry)
    if (typeof m.time === 'number') {
      if (m.time > newestTime) newestTime = m.time
      if (m.time < oldestTime) oldestTime = m.time
    }
  }

  const nameFor = (mail, fallback) =>
    (canonicalNames && canonicalNames.get(mail)) || fallback

  const owners = [...byMail.entries()]
    .map(([mail, v]) => ({ author: nameFor(mail, v.name), lines: v.lines, share: v.lines / total }))
    .sort((a, b) => b.lines - a.lines)

  const result = {
    total,
    owners,
    newestLineAgeDays: Number.isFinite(newestTime) ? ageDays(newestTime, now) : null,
    oldestLineAgeDays: Number.isFinite(oldestTime) ? ageDays(oldestTime, now) : null,
  }

  if (includeLines) {
    const nameByMail = new Map([...byMail.entries()].map(([mail, v]) => [mail, v.name]))
    result.lines = perLine.map(({ sha, finalLine }) => {
      const m = meta.get(sha) || {}
      const mail = m.mail || m.author || 'unknown'
      const own = nameByMail.get(mail) || m.author || 'unknown'
      return { n: finalLine, author: nameFor(mail, own), ageDays: ageDays(m.time, now) }
    })
  }

  return result
}

// `git log -<count> --numstat --format=\x01%h<US>%ae<US>%an<US>%at<US>%s`,
// repo-wide (no `--` path filter, no `--follow`). \x01 marks the start of a
// commit's header line — chosen over reusing US alone because a header line
// carries several US-joined fields and the numstat rows that follow it don't
// have a marker of their own, so something has to say "new commit starts
// here". Not the same 40-hex sha-only line trick churn parsing uses (that
// only works there because sha and numstat never sit next to arbitrary
// text). \x01 is control-code territory same as US; a commit subject
// containing it is exactly as unlikely as one containing \x1f.
//
// canonicalNames (email -> display name, see parseCanonicalNames) resolves
// each commit's author the same way shortlog's dedup does, so a split
// identity (this repo's own `mohsensc` / `Mohsen Sarrafan Chaharsoughi`)
// shows one name on the board, not two.
export function parseRecentLog(text, now = Date.now(), canonicalNames = new Map()) {
  const lines = text.split('\n')
  const raw = []
  let cur = null
  for (const line of lines) {
    if (line.startsWith('\x01')) {
      if (cur) raw.push(cur)
      const [sha, email, author, at, ...subjectParts] = line.slice(1).split(US)
      cur = { sha, email, author, at: parseInt(at, 10), subject: subjectParts.join(US), files: 0 }
    } else if (cur && NUMSTAT_LINE.test(line)) {
      cur.files++
    }
  }
  if (cur) raw.push(cur)
  return raw.map((e) => ({
    sha: e.sha,
    author: (canonicalNames && canonicalNames.get(e.email)) || e.author,
    subject: e.subject,
    ageDays: ageDays(e.at, now),
    files: e.files,
  }))
}

// `git log --follow -n <n> --date=relative --format=%h<US>%an<US>%ad<US>%s`
export function parseLog(text) {
  if (!text.trim()) return []
  return text.split('\n').filter(Boolean).map((line) => {
    const [sha, author, when, ...rest] = line.split(US)
    return { sha, author, when, subject: rest.join(US) }
  })
}

// `git shortlog -sne` — "  <count>\t<name> <email>" per line (the `e`
// flag is what makes dedup possible at all: two rows can share a name by
// coincidence, but not an inbox). Share and cross-row merging are left to
// the caller.
export function parseShortlog(text) {
  if (!text.trim()) return []
  const owners = []
  for (const line of text.split('\n')) {
    const m = /^\s*(\d+)\t(.+)\s<([^>]*)>$/.exec(line)
    if (!m) continue
    owners.push({ author: m[2], email: m[3], commits: parseInt(m[1], 10) })
  }
  return owners
}

// `git log --format=%ae<US>%an` — one line per commit, newest first
// (git's default order). First line seen for an email wins, which makes
// this map "the display name on that email's most recent commit" —
// exactly the canonical spelling to show for a split identity.
export function parseCanonicalNames(text) {
  const byEmail = new Map()
  for (const line of text.split('\n')) {
    if (!line) continue
    const [email, name] = line.split(US)
    if (email && name && !byEmail.has(email)) byEmail.set(email, name)
  }
  return byEmail
}

// Collapses shortlog rows that share an email (two name spellings of one
// person) into one row, summing commit counts and using the canonical
// name for that email when one's available.
export function mergeAuthorsByEmail(rows, canonicalNames) {
  const byEmail = new Map()
  for (const row of rows) {
    const key = row.email || row.author
    const name = (canonicalNames && canonicalNames.get(row.email)) || row.author
    const prev = byEmail.get(key)
    if (prev) {
      prev.commits += row.commits
      if (name) prev.author = name
    } else {
      byEmail.set(key, { author: name, commits: row.commits })
    }
  }
  return [...byEmail.values()].sort((a, b) => b.commits - a.commits)
}

// `git log --follow --format=%an<US>%at<US>%s` (newest first, no -n cap).
export function parseStatLog(text, now = Date.now(), canonicalNames = new Map()) {
  const rows = text.split('\n').filter(Boolean).map((line) => {
    const [addr, author, at, ...rest] = line.split(US)
    return { addr, author, at: parseInt(at, 10), subject: rest.join(US) }
  })
  if (rows.length === 0) return null
  // By address, not by name: one person committing as both `mohsensc` and
  // `Mohsen Sarrafan Chaharsoughi` is one author, and "2 authors" on a file
  // only they have ever touched is a wrong fact, not a cosmetic one.
  const authors = new Set(rows.map((r) => r.addr || r.author))
  const newest = rows[0]
  const oldest = rows[rows.length - 1]
  return {
    commits: rows.length,
    authorCount: authors.size,
    lastAuthor: (canonicalNames && canonicalNames.get(newest.addr)) || newest.author,
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
export function clampLine(raw) {
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

// The source route's line cap — 200 real lines is plenty for a gutter
// view and keeps the response small even on a huge file.
const SOURCE_LINE_CAP = 200

// `git show HEAD:<path>` output in, `{ ok, lines }` or `{ ok:false,
// reason }` out. Pure and synchronous so it's cheap to unit-test without
// shelling out — the route just hands it real stdout.
export function sliceSourceLines(text, startRaw, endRaw) {
  if (text.includes('\x00')) return { ok: false, reason: 'binary file' }
  const allLines = text.length === 0 ? [] : text.split('\n')
  // git show ends text files with a trailing newline, which turns into a
  // trailing empty element after split — drop it so line counts match
  // what an editor would show.
  if (allLines.length > 0 && allLines[allLines.length - 1] === '') allLines.pop()
  if (allLines.length === 0) return { ok: false, reason: 'empty file' }

  let start = clampLine(startRaw)
  let end = clampLine(endRaw)
  if (start == null) start = 1
  if (end == null) end = allLines.length
  if (start > allLines.length) return { ok: false, reason: 'start beyond end of file' }
  if (end < start) end = start
  end = Math.min(end, start + SOURCE_LINE_CAP - 1, allLines.length)

  return { ok: true, lines: allLines.slice(start - 1, end) }
}

// ---------------------------------------------------------------------
// Path/dir validation. The allowlist is "actually a tracked path in this
// repo right now" — nothing else gets near execFile's argv.
// ---------------------------------------------------------------------

async function trackedFiles(repoRoot) {
  const { stdout } = await execFileP('git', ['ls-files'], { cwd: repoRoot })
  return stdout.split('\n').filter(Boolean)
}

/** Repo-wide address -> display name, newest commit wins. Every route that
 *  puts a person's name on screen resolves through this, so the blame card,
 *  the zone plaque, the commit board and the ambient stats can't disagree
 *  about what one human is called. Uncached, same as trackedFiles above —
 *  this is a dev-server middleware and a `git log` on this repo is a few ms. */
async function canonicalNamesFor(repoRoot) {
  const { stdout } = await execFileP('git', ['log', `--format=%ae${US}%an`], { cwd: repoRoot })
  return parseCanonicalNames(stdout)
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
        const [{ stdout }, canonicalNames] = await Promise.all([
          execFileP(
            'git', ['log', '--follow', `--format=%ae${US}%an${US}%at${US}%s`, '--', p],
            { cwd: repoRoot }
          ),
          canonicalNamesFor(repoRoot),
        ])
        const stat = parseStatLog(stdout, Date.now(), canonicalNames)
        if (!stat) return sendJson(res, { ok: false, reason: 'no history' })
        return sendJson(res, { ok: true, ...stat })
      }

      if (route === 'blame') {
        const p = url.searchParams.get('path')
        if (!isTrackedPath(p, files)) return sendJson(res, { ok: false, reason: 'not a tracked path' })
        const start = clampLine(url.searchParams.get('start'))
        const end = clampLine(url.searchParams.get('end'))
        const rangeArgs = start != null && end != null ? ['-L', `${start},${end}`] : []
        // Opt-in per-line breakdown for the region-blame gutter view. Only
        // worth the payload when there's an actual range and it's small —
        // whole-file per-line dumps aren't something any consumer wants,
        // so silently omit rather than 500 or truncate awkwardly.
        const wantLines = url.searchParams.get('lines') === '1'
          && rangeArgs.length > 0 && (end - start + 1) <= 150
        try {
          const [{ stdout }, canonicalNames] = await Promise.all([
            execFileP('git', ['blame', '--porcelain', ...rangeArgs, '--', p], { cwd: repoRoot }),
            canonicalNamesFor(repoRoot),
          ])
          return sendJson(res, { ok: true, ...parseBlamePorcelain(stdout, Date.now(),
            { includeLines: wantLines, canonicalNames }) })
        } catch {
          // untracked, binary, or empty file — git blame exits non-zero for
          // all of these. Design for it, don't special-case it. A bogus
          // range (start past EOF) also lands here; same fallback.
          return sendJson(res, { ok: false, reason: 'no blame available' })
        }
      }

      if (route === 'source') {
        const p = url.searchParams.get('path')
        if (!isTrackedPath(p, files)) return sendJson(res, { ok: false, reason: 'not a tracked path' })
        try {
          const { stdout } = await execFileP(
            'git', ['show', `HEAD:${p}`], { cwd: repoRoot, maxBuffer: 8 * 1024 * 1024 }
          )
          return sendJson(res, sliceSourceLines(stdout, url.searchParams.get('start'), url.searchParams.get('end')))
        } catch {
          // not tracked at HEAD yet (new/staged-only file), or git show
          // otherwise balked — same "degrade, don't 500" shape as blame.
          return sendJson(res, { ok: false, reason: 'not available at HEAD' })
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

      if (route === 'recent') {
        // Repo-wide, no path/dir — the commit board's "what's been
        // happening in here" prop, not tied to one file or zone. `count`
        // mirrors `log`'s `n` param name/clamp but under its own name since
        // this is a distinct route with a distinct (numstat-bearing, no
        // `--follow`, no path filter) shape rather than `log` with an
        // optional path — changing `log` itself would mean auditing every
        // existing caller (blamecard.js's per-file commit list) for a
        // param it never asked for.
        const count = Math.max(1, Math.min(30, parseInt(url.searchParams.get('count') || '8', 10) || 8))
        const [recentOut, canonicalNames] = await Promise.all([
          // --no-merges: a merge commit has no numstat rows of its own, so it
          // arrives as `files: 0` and the board renders "0 files" next to
          // "Merge pull request #58". `-m` would fix the count by emitting one
          // numstat section per parent, which double-counts instead. The board
          // wants the commits somebody wrote, and the sibling `churn` and `log`
          // routes already skip merges for free — a pathspec makes git prune
          // merges that are TREESAME to a parent. This route has no pathspec,
          // so it has to say so.
          execFileP(
            'git',
            ['log', `-${count}`, '--no-merges', `--format=%x01%h${US}%ae${US}%an${US}%at${US}%s`, '--numstat'],
            { cwd: repoRoot }
          ),
          canonicalNamesFor(repoRoot),
        ])
        return sendJson(res, { ok: true, entries: parseRecentLog(recentOut.stdout, Date.now(), canonicalNames) })
      }

      if (route === 'shortlog') {
        const d = url.searchParams.get('dir') || ''
        if (!isTrackedDir(d, files)) return sendJson(res, { ok: false, reason: 'not a tracked dir' })
        const pathArgs = d === '' || d === '.' ? [] : ['--', d]
        // Two calls: -sne for the counts, canonicalNamesFor for the display
        // names, so a split identity (one inbox, two name spellings) merges
        // into one owner instead of two.
        //
        // The name map is repo-wide even though the counts are dir-scoped.
        // Scoped, it answered "the spelling they last used in this folder",
        // which is a different name than the same person gets on a blame card
        // or the commit board — that mismatch was visible in one frame, a
        // plaque reading "Mohsen Sarrafan Chaharsoughi" over a card reading
        // "mohsensc".
        const [shortlogOut, canonicalNames] = await Promise.all([
          execFileP('git', ['shortlog', '-sne', 'HEAD', ...pathArgs], { cwd: repoRoot }),
          canonicalNamesFor(repoRoot),
        ])
        const rows = parseShortlog(shortlogOut.stdout)
        const owners = mergeAuthorsByEmail(rows, canonicalNames)
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
