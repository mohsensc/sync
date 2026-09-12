#!/usr/bin/env node
// A static Vercel deploy has no dev server, so gitapi.mjs's /api/git/*
// middleware (see vite.config.js's configureServer hook) never runs there.
// This reproduces just the one route the commit board actually needs —
// /api/git/recent — as a static JSON file written into public/ before
// `vite build` copies it into dist/. Snapshot is as-of-deploy, not live;
// that's an accepted tradeoff for a demo, not a bug.
//
// Everything else gitapi.mjs serves (blame/stat/churn/log/shortlog) is left
// alone: those routes 404 in production and every consumer already treats a
// failed fetch as "no signal" (see gitsignals.js/zoneowner.js/ghost.js/
// blamecard.js/histshelf.js), so they degrade gracefully with no extra work.
//
// Reuses gitapi.mjs's own parsers rather than re-deriving the shape, so this
// can't quietly drift from what the real dev endpoint returns.
import { execFile } from 'node:child_process'
import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { parseRecentLog, parseCanonicalNames } from '../gitapi.mjs'

const execFileP = promisify(execFile)
const US = '\x1f'
const MAX_BUFFER = 8 * 1024 * 1024
const COUNT = 30 // commitboard.js's own cap is 8; extra headroom costs nothing here

const here = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(here, '../..')
const outFile = path.resolve(here, '../public/api/git/recent')

async function canonicalNames() {
  const { stdout } = await execFileP(
    'git', ['log', `--format=%ae${US}%an`], { cwd: repoRoot, maxBuffer: MAX_BUFFER }
  )
  return parseCanonicalNames(stdout)
}

async function snapshot() {
  const [{ stdout }, names] = await Promise.all([
    execFileP(
      'git',
      ['log', `-${COUNT}`, '--no-merges', `--format=%x01%h${US}%ae${US}%an${US}%at${US}%s`, '--numstat'],
      { cwd: repoRoot, maxBuffer: MAX_BUFFER }
    ),
    canonicalNames(),
  ])
  return { ok: true, entries: parseRecentLog(stdout, Date.now(), names) }
}

async function main() {
  let body
  try {
    body = await snapshot()
  } catch (err) {
    // Shallow clone, no .git, git missing — same "degrade, don't fail the
    // build" shape gitapi.mjs's own routes use.
    console.warn('git snapshot unavailable, writing ok:false:', err.message)
    body = { ok: false, reason: 'snapshot unavailable' }
  }
  await mkdir(path.dirname(outFile), { recursive: true })
  await writeFile(outFile, JSON.stringify(body))
  console.log(`wrote ${path.relative(repoRoot, outFile)}` +
    (body.ok ? ` (${body.entries.length} commits)` : ' (ok:false)'))
}

main()
