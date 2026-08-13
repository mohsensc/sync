// Wires the office scene to the git-data endpoints (see gitapi.mjs) without
// ever risking the scene on it. Two ambient signals live here:
//
//  - freshness: how old is the last commit touching whatever an agent is
//    holding right now (agent.gitPath). Drives Agent.setFreshness().
//  - area ownership: who has written the most into a zone's slice of the
//    tree (git shortlog). Drives zones.setOwner().
//
// Both poll on an interval instead of per frame — git shortlog especially is
// not free enough to run 60x/s, and neither number needs to be. Every
// failure (endpoint not up yet, path outside the repo, network hiccup) is
// swallowed silently: this file's whole job is to be a nice-to-have that
// never breaks the room.

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

/**
 * @param {object} opts
 * @param {{agents: Array<{gitPath?: string, setFreshness?: Function}>}} opts.world
 * @param {{setOwner?: Function}} opts.zones
 * @param {typeof fetch} [opts.fetchFn]
 * @param {number} [opts.intervalMs]
 * @param {Record<string,string>} [opts.zoneDirs]
 */
export function attachGitSignals({ world, zones, fetchFn = fetch, intervalMs = DEFAULT_INTERVAL_MS, zoneDirs = ZONE_DIRS } = {}) {
  const statCache = new Map() // path -> { t, ageDays }
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

  async function pollZone(zoneName, dir) {
    const cached = ownerCache.get(dir)
    if (cached && Date.now() - cached.t < intervalMs * 3) {
      if (cached.owner) zones.setOwner?.(zoneName, cached.owner)
      return
    }
    try {
      const data = await getJson(`/api/git/shortlog?dir=${encodeURIComponent(dir)}`)
      const owner = shortlogToOwner(data)
      ownerCache.set(dir, { t: Date.now(), owner })
      if (owner) zones.setOwner?.(zoneName, owner)
    } catch {
      // leave whatever the zone last showed alone — a blip shouldn't erase it
    }
  }

  async function tick() {
    const agents = (world && world.agents) || []
    await Promise.all(agents.map(a => pollAgent(a).catch(() => {})))
    await Promise.all(Object.entries(zoneDirs).map(([z, dir]) => pollZone(z, dir).catch(() => {})))
  }

  tick()
  const timer = setInterval(() => { tick() }, intervalMs)

  return { tick, stop: () => clearInterval(timer) }
}
