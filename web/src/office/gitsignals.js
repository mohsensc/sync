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
//
// The churn number also drives a second, swappable layer: three distinct
// treatments of "how busy/stale does this file look", cycled with the 'C'
// key or ?churnMode=. See CHURN_MODES / staleToIntensity / applyChurnVis
// below for the how; dressing.js's deskHeat/deskDust for the what.

import { deskHeat, deskDust } from './dressing.js'
import { makeAmbientThrottle } from './frame-throttle.js'

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

// ---------------------------------------------------------------------
// Churn treatments: three distinct looks at the same two numbers
// (churn intensity, file age), cycled with the 'C' key or ?churnMode=.
//   'stack' (default) — agent.js's built-in typing-speed bump and paper
//     stack. Untouched here; this file just keeps calling setChurn() the
//     way it always has.
//   'heat'  — dressing.js's deskHeat(): a warm glow that breathes and
//     steam that drifts, scaled by churnToIntensity. Alive, because
//     churn is something happening right now.
//   'cold'  — dressing.js's deskDust(): a settled haze and a small
//     cobweb that fade in once a file's last commit is genuinely old
//     (staleToIntensity below). Deliberately inert — see dressing.js's
//     header for why "hasn't been touched in a year" shouldn't move.
// Self-contained (own keydown listener) for the same reason zoneowner.js
// and histshelf.js are. The heat glow used to run its own rAF loop for the
// same reason — no tick()/keydown seam to hook a fourth signal into — but
// office.html now runs one frame loop for the whole page and calls every
// module's tick(dt); this file's per-frame work (the heat glow's breathe)
// rides that instead. See attachGitSignals's own tick(dt) below.
// ---------------------------------------------------------------------

export const CHURN_MODES = ['stack', 'heat', 'cold']

function initialChurnMode() {
  try {
    const m = new URLSearchParams(location.search).get('churnMode')
    return CHURN_MODES.includes(m) ? m : 'stack'
  } catch {
    return 'stack' // no `location` outside a browser
  }
}

// Below the floor a file just looks recently touched — no dust. At/above
// the ceiling it reads as fully abandoned. A repo's own commit rhythm
// picked these, not a calendar rule: 60 days is "nobody's mentioned this
// in two months", 365 is "a full year", which is squarely inside FRESH's
// own 'stale' bucket (agent.js, >=180d) rather than a brand new tier.
const STALE_FLOOR_DAYS = 60
const STALE_CEIL_DAYS = 365

/** ageDays -> 0..1 "how abandoned does this feel", for the 'cold'
 *  treatment. Pure, same "no signal reads as 0, not NaN" contract as
 *  churnToIntensity/freshnessBucket. */
export function staleToIntensity(ageDays) {
  if (ageDays == null || !Number.isFinite(ageDays) || ageDays < 0) return 0
  if (ageDays <= STALE_FLOOR_DAYS) return 0
  if (ageDays >= STALE_CEIL_DAYS) return 1
  return (ageDays - STALE_FLOOR_DAYS) / (STALE_CEIL_DAYS - STALE_FLOOR_DAYS)
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

  // -- churn-vis: desk-level 'heat'/'cold' treatments, see the comment
  // above staleToIntensity for what they are and why they live here.
  let churnMode = initialChurnMode()
  const fxByAgent = new Map()   // agent -> { heat, cold } (dressing.js instances)
  const gitByAgent = new Map()  // agent -> { ageDays, intensity } — last known, for reapplying on a mode switch

  function stateFor(a) {
    let s = gitByAgent.get(a)
    if (!s) { s = { ageDays: null, intensity: 0 }; gitByAgent.set(a, s) }
    return s
  }

  // Lazily built the first time an agent is ever polled, and only when it
  // actually carries a real root to hang props off — every existing test
  // fixture is a plain object with no .root, so this is a no-op there,
  // same "no DOM, no problem" shape the rest of this file already has.
  function fxFor(a) {
    if (fxByAgent.has(a)) return fxByAgent.get(a)
    if (!a || !a.root || typeof a.root.add !== 'function') return null
    const scale = (typeof a.scale === 'number' && a.scale) || 1
    const fx = {
      heat: deskHeat(a.root, 0.5 * scale, 0, -0.24 * scale),
      cold: deskDust(a.root, 0.5 * scale, 0, -0.24 * scale),
    }
    fxByAgent.set(a, fx)
    return fx
  }

  /** Re-renders one agent's desk-fx from its last known numbers and the
   *  current churnMode. Cheap and idempotent — safe to call on every poll
   *  AND on every mode switch. */
  function applyChurnVis(a) {
    const st = stateFor(a)
    const fx = fxFor(a)
    if (!fx) return
    if (churnMode === 'heat') {
      fx.heat.set(st.intensity); fx.cold.set(0)
    } else if (churnMode === 'cold') {
      fx.heat.set(0); fx.cold.set(staleToIntensity(st.ageDays))
    } else {
      fx.heat.set(0); fx.cold.set(0) // 'stack' — agent.js's own paper stack carries this signal
    }
  }

  async function getJson(url) {
    const res = await fetchFn(url)
    if (!res || !res.ok) return null
    return res.json()
  }

  async function pollAgent(a) {
    if (!a.gitPath) { a.setFreshness?.(null); stateFor(a).ageDays = null; applyChurnVis(a); return }
    const cached = statCache.get(a.gitPath)
    if (cached && Date.now() - cached.t < STAT_TTL_MS) {
      a.setFreshness?.(cached.ageDays)
      stateFor(a).ageDays = cached.ageDays
      applyChurnVis(a)
      return
    }
    try {
      const data = await getJson(`/api/git/stat?path=${encodeURIComponent(a.gitPath)}`)
      const ageDays = statToAgeDays(data)
      statCache.set(a.gitPath, { t: Date.now(), ageDays })
      a.setFreshness?.(ageDays)
      stateFor(a).ageDays = ageDays
      applyChurnVis(a)
    } catch {
      a.setFreshness?.(null)
      stateFor(a).ageDays = null
      applyChurnVis(a)
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
      if (cached.intensity != null) {
        stateFor(a).intensity = cached.intensity
        // Only 'stack' reads setChurn — 'heat'/'cold' get this same number
        // through applyChurnVis below instead, and leave the built-in
        // paper-stack prop at 0 (see applyChurnVis).
        if (churnMode === 'stack') a.setChurn?.(cached.intensity)
        applyChurnVis(a)
      }
      return
    }
    try {
      const data = await getJson(`/api/git/churn?path=${encodeURIComponent(a.gitPath)}`)
      const intensity = churnToIntensity(data)
      churnCache.set(a.gitPath, { t: Date.now(), intensity })
      if (intensity != null) {
        stateFor(a).intensity = intensity
        if (churnMode === 'stack') a.setChurn?.(intensity)
        applyChurnVis(a)
      }
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

  // Renamed from the generic `tick` to `poll` so it doesn't collide with
  // the per-frame tick(dt) below — this one hits the network on a timer,
  // that one runs off office.html's frame loop. Same "poll now" contract
  // zoneowner.js's own tick() still has (it never grew a per-frame half).
  async function poll() {
    const agents = (world && world.agents) || []
    await Promise.all(agents.map(a => pollAgent(a).catch(() => {})))
    await Promise.all(agents.map(a => pollChurn(a).catch(() => {})))
    await Promise.all(Object.entries(zoneDirs).map(([z, dir]) => pollZone(z, dir).catch(() => {})))
  }

  poll()
  const timer = setInterval(() => { poll() }, intervalMs)

  // 'C' cycles stack -> heat -> cold -> stack. Re-renders every known
  // agent immediately from its last-known numbers rather than waiting
  // for the next poll, so the switch reads instantly.
  function setChurnMode(mode) {
    if (!CHURN_MODES.includes(mode)) return
    churnMode = mode
    const agents = (world && world.agents) || []
    agents.forEach(applyChurnVis)
  }
  function onKeydown(e) {
    if (e.key !== 'c' && e.key !== 'C') return
    const tag = (document.activeElement && document.activeElement.tagName) || ''
    if (tag === 'INPUT' || tag === 'TEXTAREA') return
    setChurnMode(CHURN_MODES[(CHURN_MODES.indexOf(churnMode) + 1) % CHURN_MODES.length])
  }
  if (typeof addEventListener === 'function') addEventListener('keydown', onKeydown)

  // The heat treatment's glow/steam need per-frame motion; the poll loop
  // above only runs every intervalMs. Driven from office.html's one shared
  // frame loop now instead of its own rAF — the breathe is a slow ambient
  // effect (see frame-throttle.js), so it only actually steps at ~20Hz,
  // not every frame.
  const ambient = makeAmbientThrottle()
  function tick(dt) {
    const elapsed = ambient(dt)
    if (!elapsed) return
    for (const fx of fxByAgent.values()) fx.heat.update(elapsed)
  }

  // Per-agent counterpart to stop(): office.html's despawnLive calls this
  // for one agent instead of waiting for the whole room to tear down.
  // A WeakMap wouldn't need this call at all, but that's the trap — GC
  // eventually reclaiming the JS wrapper says nothing about the GPU-side
  // geometry deskHeat/deskDust allocated, which only a dispose() call frees.
  // Called before despawnLive's own a.root.traverse: fx.dispose() detaches
  // the heat/cold groups from a.root (parent.remove), so that traverse
  // never sees them and doesn't double-dispose their materials.
  function forget(a) {
    const fx = fxByAgent.get(a)
    if (fx) { fx.heat.dispose(); fx.cold.dispose() }
    fxByAgent.delete(a)
    gitByAgent.delete(a)
  }

  return {
    poll,
    tick,
    forget,
    stop: () => {
      clearInterval(timer)
      if (typeof removeEventListener === 'function') removeEventListener('keydown', onKeydown)
      for (const fx of fxByAgent.values()) { fx.heat.dispose(); fx.cold.dispose() }
      fxByAgent.clear()
    },
    get churnMode() { return churnMode },
    setChurnMode,
  }
}
