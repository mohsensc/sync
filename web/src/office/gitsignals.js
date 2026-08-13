// Wires the office scene to the git-data endpoints (see gitapi.mjs) without
// ever risking the scene on it. Three ambient signals live here:
//
//  - freshness: how old is the last commit touching whatever an agent is
//    holding right now (agent.gitPath). Drives Agent.setFreshness().
//  - churn: how much that same file has moved lately — 14-day git log plus
//    the uncommitted working-tree diff, weighted toward "right now" over
//    "recently". Drives Agent.setChurn(). Orthogonal to freshness: a file
//    can be old-but-suddenly-busy or young-but-quiet, and those should not
//    look the same.
//  - area ownership: who has written the most into a zone's slice of the
//    tree (git shortlog). Drives zones.setOwner().
//
// All three poll on an interval instead of per frame — git shortlog especially
// is not free enough to run 60x/s, and none of these numbers need to be.
// Every failure (endpoint not up yet, path outside the repo, network hiccup)
// is swallowed silently: this file's whole job is to be a nice-to-have that
// never breaks the room. The churn route in particular may not exist yet on
// a given checkout (see gitapi.mjs's task-1 seam) — a 404 there degrades the
// exact same way a network hiccup would, no special-casing needed.

const DEFAULT_INTERVAL_MS = 20_000
const STAT_TTL_MS = 20_000

// Static zone -> repo directory map for the "who owns this area" flourish.
// Picked by eye against the actual tree: desks is the general web source
// bank, vault is auth/leases in the go daemon+relay, whiteboard is the
// office scene itself (the most actively bikeshedded corner of the repo
// this round). Zones with no obvious matching directory are left unmapped
// on purpose — a made-up mapping is worse than no flourish there.
export const ZONE_DIRS = {
  desks: 'web/src',
  vault: 'go',
  whiteboard: 'web/src/office',
}

/** {ok:true, lastAgeDays, ...} -> a number, or null for anything else
 *  (ok:false, malformed body, missing field). Pure, so it's testable without
 *  a fetch. */
export function statToAgeDays(data) {
  if (!data || data.ok !== true) return null
  const n = data.lastAgeDays
  return typeof n === 'number' && Number.isFinite(n) ? n : null
}

/** {ok:true, owners:[{author, commits, share}, ...]} -> the top author's
 *  name, or null. Owners is expected sorted by the endpoint, but this sorts
 *  again defensively rather than trust it blindly. */
export function shortlogToOwner(data) {
  if (!data || data.ok !== true || !Array.isArray(data.owners) || !data.owners.length) return null
  const top = [...data.owners].sort((a, b) => (b.commits || 0) - (a.commits || 0))[0]
  return top && top.author ? top.author : null
}

const num = n => (typeof n === 'number' && Number.isFinite(n) ? n : 0)

/** {ok:true, recent:{commits,added,deleted,windowDays}, working:{added,deleted}}
 *  -> a 0..1 "how busy does this look" number, or null for anything else
 *  (ok:false, both `recent` and `working` missing — the shape gitapi.mjs's
 *  churn route always sends on success, so absent means the route either
 *  isn't up yet or sent garbage, and that reads as "unknown" the same way
 *  statToAgeDays treats a malformed stat body).
 *
 *  `working` — uncommitted lines changed right now — is weighted heaviest:
 *  it is literally what the agent is doing this second. `recent` (14-day
 *  git log) is the lighter "this area's been busy lately" signal, and a
 *  raw commit count on top of both rewards a file that's been touched by
 *  many small commits even if none of them were huge. Squashed through a
 *  soft exponential knee rather than a hard cap — a first small edit
 *  already reads as SOME churn instead of needing to clear a threshold. */
export function churnToIntensity(data) {
  if (!data || data.ok !== true) return null
  const { recent, working } = data
  if (!recent && !working) return null
  const rec = recent || {}, wk = working || {}
  const workingLines = num(wk.added) + num(wk.deleted)
  const recentLines = num(rec.added) + num(rec.deleted)
  const score = workingLines * 3 + recentLines * 0.5 + num(rec.commits) * 2
  return score <= 0 ? 0 : 1 - Math.exp(-score / 40)
}

/**
 * @param {object} opts
 * @param {{agents: Array<{gitPath?: string, setFreshness?: Function, setChurn?: Function}>}} opts.world
 * @param {{setOwner?: Function}} opts.zones
 * @param {{set?: Function}} [opts.ownership] optional sink for the full
 *   shortlog body per zone (author shares, runner-up), not just the top
 *   name `zones.setOwner` gets — see zoneowner.js's pickOwnership().
 * @param {typeof fetch} [opts.fetchFn]
 * @param {number} [opts.intervalMs]
 * @param {Record<string,string>} [opts.zoneDirs]
 */
export function attachGitSignals({ world, zones, ownership, fetchFn = fetch, intervalMs = DEFAULT_INTERVAL_MS, zoneDirs = ZONE_DIRS } = {}) {
  const statCache = new Map() // path -> { t, ageDays }
  const churnCache = new Map() // path -> { t, intensity }
  const ownerCache = new Map() // dir -> { t, owner }

  async function getJson(url) {
    const res = await fetchFn(url)
    if (!res || !res.ok) return null
    return res.json()
  }

  async function pollAgent(a) {
    if (!a.gitPath) { a.setFreshness?.(null); return }
    const cached = statCache.get(a.gitPath)
    if (cached && Date.now() - cached.t < STAT_TTL_MS) {
      a.setFreshness?.(cached.ageDays)
      return
    }
    try {
      const data = await getJson(`/api/git/stat?path=${encodeURIComponent(a.gitPath)}`)
      const ageDays = statToAgeDays(data)
      statCache.set(a.gitPath, { t: Date.now(), ageDays })
      a.setFreshness?.(ageDays)
    } catch {
      a.setFreshness?.(null)
    }
  }

  // Unlike pollAgent, a missing/failed churn read is a true no-op: it does
  // NOT call setChurn(null) to clear anything, because there's nothing to
  // clear a false "not busy" onto — Agent.setChurn defaults to 0 already,
  // and re-asserting 0 on every blip would fight the eased ramp back down.
  // This is also what makes building against this file safe before the
  // churn route lands: 404 -> getJson returns null -> churnToIntensity
  // returns null -> nothing happens.
  async function pollChurn(a) {
    if (!a.gitPath) return
    const cached = churnCache.get(a.gitPath)
    if (cached && Date.now() - cached.t < STAT_TTL_MS) {
      if (cached.intensity != null) a.setChurn?.(cached.intensity)
      return
    }
    try {
      const data = await getJson(`/api/git/churn?path=${encodeURIComponent(a.gitPath)}`)
      const intensity = churnToIntensity(data)
      churnCache.set(a.gitPath, { t: Date.now(), intensity })
      if (intensity != null) a.setChurn?.(intensity)
    } catch {
      // route not up yet, network hiccup, whatever — leave it alone
    }
  }

  async function pollZone(zoneName, dir) {
    const cached = ownerCache.get(dir)
    if (cached && Date.now() - cached.t < intervalMs * 3) {
      if (cached.owner) zones.setOwner?.(zoneName, cached.owner)
      ownership?.set?.(zoneName, cached.data)
      return
    }
    try {
      const data = await getJson(`/api/git/shortlog?dir=${encodeURIComponent(dir)}`)
      const owner = shortlogToOwner(data)
      ownerCache.set(dir, { t: Date.now(), owner, data })
      if (owner) zones.setOwner?.(zoneName, owner)
      // `ownership` gets the whole body (shares, runner-up, author count),
      // not just the top name zones.setOwner wants — zoneowner.js's
      // pickOwnership() is what turns that into plaque/rug/flourish
      // decisions. Not wired into office.html's existing attachGitSignals()
      // call this round: that call sits outside this round's append-only
      // slice of the file (see STATE.md), so zoneowner.js runs its own
      // poll loop for now rather than needing this sink. Left in place —
      // cheap, tested, and it's the seam a future round should use instead
      // of adding a third shortlog poller.
      ownership?.set?.(zoneName, data)
    } catch {
      // leave whatever the zone last showed alone — a blip shouldn't erase it
    }
  }

  async function tick() {
    const agents = (world && world.agents) || []
    await Promise.all(agents.map(a => pollAgent(a).catch(() => {})))
    await Promise.all(agents.map(a => pollChurn(a).catch(() => {})))
    await Promise.all(Object.entries(zoneDirs).map(([z, dir]) => pollZone(z, dir).catch(() => {})))
  }

  tick()
  const timer = setInterval(() => { tick() }, intervalMs)

  return { tick, stop: () => clearInterval(timer) }
}
