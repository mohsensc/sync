// Zone ownership as room dressing: turns `git shortlog` per zone into
// physical props instead of the one-line "mostly <name>" text already
// stitched into the zone marker's label (see zones.js's setOwner, wired
// from gitsignals.js's pollZone).
//
// Two treatments behind one key toggle (press U, or load with
// ?zoMode=plaque — 'rug' is the default):
//   'rug'    — a floor mat tinted by the owner's colour with a second
//     woven stripe for the runner-up. Default because it reads as part of
//     the room; a floating sign every time you glance at a desk bank got
//     loud fast (round 4 review: "a tooltip cosplaying as a prop").
//   'plaque' — a wall-style sign floating over the zone, owner's name in
//     their palette hair colour, sized by commit share. Still here,
//     still one keypress away, for whenever the room needs to spell it
//     out (screenshots, a walkthrough) rather than just imply it.
// Both modes also get an ambient flourish when the numbers are lopsided
// enough to say something with a prop instead of a label: a trophy for a
// zone one human clearly owns (>=80% share), two mugs side by side for one
// that's genuinely split. Anything in between gets dressing but no
// flourish — most zones most of the time, and that's fine, not everything
// needs to shout.
//
// Single-owner calm: once a zone has exactly one author — which, after
// gitapi.mjs's email dedup, is most of this repo's own history — a
// trophy for "the only person who could possibly own this" states the
// obvious, and a plaque doing long division to print "100%" is worse
// than just saying so. See ownerLine()/flourishFor() below: no flourish,
// no percentage, just "all <name>" — the same phrasing zones.js's floor
// pill uses for a single-owner zone, so the two surfaces agree.
//
// Degrade rule: no shortlog data (fresh dir, endpoint not up, network
// hiccup) means no dressing for that zone. A plaque with no name on it or
// a rug with no colour is worse than an empty patch of floor.

import * as THREE from 'three'
import { ZONES } from './zones.js'

// ---------------------------------------------------------------------
// Colour: re-hosted from web/src/palette.ts. office/*.js is unbundled
// plain JS and can't import the .ts side (history-viz.js's hashString
// carries the same note for its own author-hash) — this is the same
// multiply-by-31 hash, but kept to the six-swatch HAIR_COLORS list rather
// than history-viz's full hue circle, because the brief specifically asks
// for "their palette hair color", not an arbitrary one. Swatches copied
// verbatim from palette.ts's PALETTE/HAIR_COLORS so a human and their
// character always land on the same colour.
// ---------------------------------------------------------------------

export const HAIR_COLORS = [
  '#D9714F', // terracotta
  '#8A94A3', // slateBlue
  '#D6B45C', // mustard
  '#A5738C', // mauve
  '#B0674F', // coffee
  '#E8946C', // salmon
]

/** Same hash as palette.ts's hairFor: multiply-by-31, unsigned, mod the
 *  swatch count. Parity is the whole point — this MUST return the same
 *  colour palette.ts would for the same string. */
export function hairFor(human) {
  let h = 0
  const s = String(human || '')
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0
  return HAIR_COLORS[h % HAIR_COLORS.length]
}

/** A hex string, darkened toward black by `amt` (0..1) — used for the
 *  rug's woven border, which needs to read as "an edge" against its own
 *  fill colour rather than another flat tint the eye can't separate from
 *  the pastel zone floor underneath it. */
function darken(hex, amt) {
  const n = parseInt(hex.slice(1), 16)
  const r = Math.round(((n >> 16) & 0xff) * (1 - amt))
  const g = Math.round(((n >> 8) & 0xff) * (1 - amt))
  const b = Math.round((n & 0xff) * (1 - amt))
  return (r << 16) | (g << 8) | b
}

// ---------------------------------------------------------------------
// Pure ownership math. No DOM, no THREE — layoutShelf's histshelf.js
// pattern: keep this half testable without a renderer.
// ---------------------------------------------------------------------

/** A zone one human wrote >= this share of counts as "theirs" — a trophy,
 *  not just a name on a plaque. */
export const POSSESSIVE_SHARE = 0.8
/** Top two authors within this much share of each other counts as
 *  contested — two mugs, not one. */
export const CONTESTED_MARGIN = 0.15

const num = (n) => (typeof n === 'number' && Number.isFinite(n) ? n : 0)

/**
 * {ok:true, owners:[{author,commits,share}]} -> the shape every renderer
 * here wants, or null for anything that isn't a real answer (ok:false, no
 * owners, malformed body — same "absent means unknown" contract as
 * gitsignals.js's statToAgeDays/shortlogToOwner).
 *
 * Re-sorts defensively rather than trusting the endpoint's order, with a
 * deterministic tie-break (author name) so two commits-tied authors don't
 * flicker between "top" and "second" across polls depending on object
 * insertion order.
 */
export function pickOwnership(data) {
  if (!data || data.ok !== true || !Array.isArray(data.owners) || data.owners.length === 0) return null
  const sorted = [...data.owners].sort((a, b) => {
    const dc = num(b && b.commits) - num(a && a.commits)
    if (dc !== 0) return dc
    return String((a && a.author) || '').localeCompare(String((b && b.author) || ''))
  })
  const total = sorted.reduce((sum, o) => sum + num(o && o.commits), 0)
  const shareOf = (o) => (typeof o.share === 'number' && Number.isFinite(o.share) ? o.share : (total > 0 ? num(o.commits) / total : 0))
  const top = sorted[0]
  const second = sorted[1] || null
  const topShare = shareOf(top)
  const secondShare = second ? shareOf(second) : 0
  return {
    top: { author: top.author, commits: num(top.commits), share: topShare },
    second: second ? { author: second.author, commits: num(second.commits), share: secondShare } : null,
    authorCount: sorted.length,
    possessive: topShare >= POSSESSIVE_SHARE,
    contested: !!second && (topShare - secondShare) < CONTESTED_MARGIN,
  }
}

/** The line under a plaque's name (and the quiet caption on a
 *  single-owner rug) — a percentage most of the time, but "all <name>"
 *  once a zone has exactly one author. A bar chart with one segment
 *  doesn't need the number spelled out, and "100%" reads like a stat that
 *  could have come out otherwise. Same "all <name>" voice zones.js's
 *  floor-pill sub-label uses for the same fact — see that file's
 *  setOwner — so the two surfaces never disagree about how sure they are
 *  that one person wrote something. */
export function ownerLine(ownership) {
  if (!ownership) return ''
  if (ownership.authorCount === 1) return `all ${ownership.top.author}`
  return `${Math.round(ownership.top.share * 100)}% of this area`
}

/** Commit share -> a scale multiplier for the plaque, so a zone one
 *  person has thoroughly claimed reads as a slightly bigger sign than one
 *  they merely lead. Clamped so a 100% share doesn't run away. */
export function plaqueScale(share) {
  const s = typeof share === 'number' && Number.isFinite(share) ? Math.max(0, Math.min(1, share)) : 0.5
  return 0.75 + s * 0.55
}

/** Ownership -> {topFrac, secondFrac} stripe widths for the rug, both in
 *  0..1 and summing to 1. The runner-up stripe is floored at 0.12 so it
 *  reads as a visible second colour rather than a sliver you'd need to
 *  measure to notice, and capped at 0.45 so it never out-sizes the lead. */
export function rugSplit(ownership) {
  if (!ownership || !ownership.second) return { topFrac: 1, secondFrac: 0 }
  const t = ownership.top.share
  const s = ownership.second.share
  const rest = Math.max(0, 1 - t - s)
  const secondFrac = Math.max(0.12, Math.min(0.45, s + rest * 0.4))
  return { topFrac: 1 - secondFrac, secondFrac }
}

/** Which ambient flourish, if any, a zone's ownership earns. */
export function flourishFor(ownership) {
  if (!ownership) return null
  // Single-owner calm: with no second author there is nothing to be
  // possessive OVER — a trophy for the only person who ever committed
  // here just restates authorCount. See the file header.
  if (ownership.authorCount === 1) return null
  if (ownership.possessive) return 'trophy'
  if (ownership.contested) return 'contested'
  return null
}

// ---------------------------------------------------------------------
// 3D building blocks. Shared geometry, one material per colour+kind (same
// discipline dressing.js and histshelf.js already use), so N zones' worth
// of dressing doesn't multiply draw calls.
// ---------------------------------------------------------------------

const BOX = new THREE.BoxGeometry(1, 1, 1)
const CYL = new THREE.CylinderGeometry(1, 1, 1, 16)
const RING = new THREE.RingGeometry(0.7, 1, 40)

const matCache = new Map()
function solidMat(key, colorHex, extra = {}) {
  if (!matCache.has(key)) matCache.set(key, new THREE.MeshStandardMaterial({ color: colorHex, roughness: 0.85, metalness: 0.05, ...extra }))
  return matCache.get(key)
}

function box(parent, m, w, h, d, x, y, z, ry = 0) {
  const o = new THREE.Mesh(BOX, m)
  o.scale.set(w, h, d); o.position.set(x, y, z); o.rotation.y = ry
  o.castShadow = true; o.receiveShadow = true
  parent.add(o); return o
}
function cyl(parent, m, r, h, x, y, z) {
  const o = new THREE.Mesh(CYL, m)
  o.scale.set(r * 2, h, r * 2); o.position.set(x, y, z)
  o.castShadow = true; o.receiveShadow = true
  parent.add(o); return o
}

/** A little cup-on-a-stand for a zone one human has clearly claimed. Gold
 *  stem, owner-tinted bowl — the metal reads as "trophy" even at a glance,
 *  the tint says whose. */
function buildTrophy(ownerColor) {
  const g = new THREE.Group()
  g.name = 'zoneowner-trophy'
  cyl(g, solidMat('trophyBase', 0x8A94A3), 0.075, 0.028, 0, 0.014, 0)
  cyl(g, solidMat('trophyStem', 0xD6B45C, { metalness: 0.55, roughness: 0.35 }), 0.016, 0.075, 0, 0.066, 0)
  cyl(g, solidMat('trophyCollar', 0xD6B45C, { metalness: 0.55, roughness: 0.35 }), 0.055, 0.014, 0, 0.11, 0)
  cyl(g, solidMat('trophyCup_' + ownerColor, ownerColor, { metalness: 0.3, roughness: 0.4 }), 0.062, 0.09, 0, 0.165, 0)
  return g
}

/** One small mug. Two of these, side by side, is the "contested" flourish. */
function buildMug(color) {
  const g = new THREE.Group()
  cyl(g, solidMat('mug_' + color, color), 0.045, 0.07, 0, 0.035, 0)
  const handle = new THREE.Mesh(CYL, solidMat('mugHandle', 0x6b5f56))
  handle.scale.set(0.014, 0.05, 0.014)
  handle.rotation.z = Math.PI / 2
  handle.position.set(0.05, 0.035, 0)
  handle.castShadow = true
  g.add(handle)
  return g
}

function buildFlourish(kind, ownership) {
  if (kind === 'trophy') return buildTrophy(hairFor(ownership.top.author))
  if (kind === 'contested') {
    const g = new THREE.Group()
    g.name = 'zoneowner-mugs'
    const a = buildMug(hairFor(ownership.top.author)); a.position.x = -0.075
    const b = buildMug(hairFor(ownership.second.author)); b.position.x = 0.075
    g.add(a, b)
    return g
  }
  return null
}

// ---------------------------------------------------------------------
// Plaque texture — a warm plate rather than the plain label pill zones.js
// already draws for the "mostly <name>" text, so the two don't read as
// the same object twice.
// ---------------------------------------------------------------------

function roundRectPath(g, x, y, w, h, r) {
  g.beginPath()
  g.moveTo(x + r, y)
  g.lineTo(x + w - r, y)
  g.quadraticCurveTo(x + w, y, x + w, y + r)
  g.lineTo(x + w, y + h - r)
  g.quadraticCurveTo(x + w, y + h, x + w - r, y + h)
  g.lineTo(x + r, y + h)
  g.quadraticCurveTo(x, y + h, x, y + h - r)
  g.lineTo(x, y + r)
  g.quadraticCurveTo(x, y, x + r, y)
  g.closePath()
}

function plaqueTexture(ownership) {
  const W = 460, H = 190
  const c = document.createElement('canvas')
  c.width = W; c.height = H
  const g = c.getContext('2d')
  roundRectPath(g, 5, 5, W - 10, H - 10, 16)
  g.fillStyle = '#C3B39B'; g.fill()
  g.lineWidth = 3; g.strokeStyle = 'rgba(74,31,61,0.35)'; g.stroke()

  const tint = hairFor(ownership.top.author)
  roundRectPath(g, 24, 22, W - 48, 12, 6)
  g.fillStyle = tint; g.fill()

  g.textAlign = 'center'
  g.fillStyle = '#35455C'
  g.font = '700 40px ui-sans-serif, -apple-system, Segoe UI, sans-serif'
  g.fillText(ownership.top.author, W / 2, 96)

  g.font = '400 22px ui-sans-serif, -apple-system, Segoe UI, sans-serif'
  g.fillStyle = '#6b5f56'
  g.fillText(ownerLine(ownership), W / 2, 130)

  if (ownership.second) {
    g.font = '600 16px ui-sans-serif, -apple-system, Segoe UI, sans-serif'
    g.fillStyle = hairFor(ownership.second.author)
    g.fillText(`runner-up · ${ownership.second.author}`, W / 2, 160)
  }

  const t = new THREE.CanvasTexture(c)
  t.anisotropy = 8
  return t
}

function buildPlaque(zoneDef, ownership) {
  const g = new THREE.Group()
  g.name = 'zoneowner-plaque'
  const s = plaqueScale(ownership.top.share)
  const sp = new THREE.Sprite(new THREE.SpriteMaterial({
    map: plaqueTexture(ownership), transparent: true, depthTest: false, opacity: 0.97,
  }))
  sp.scale.set(1.7 * s, 0.7 * s, 1)
  sp.position.set(zoneDef.at[0], 1.92, zoneDef.at[1])
  sp.renderOrder = 11
  g.add(sp)
  const flourish = buildFlourish(flourishFor(ownership), ownership)
  if (flourish) { flourish.position.set(zoneDef.at[0], 1.92 - 0.7 * s / 2 - 0.10, zoneDef.at[1]); g.add(flourish) }
  return g
}

/** A rug texture: owner colour fill, a runner-up stripe woven along one
 *  edge if there is a second author, a woven diagonal hatch over the
 *  whole fill, and a two-tone braided border (a dark ring inside a light
 *  one) so it reads as a mat with a physical edge rather than another
 *  pastel tint at a glance — round 5's flat single-colour fill with a
 *  thin light stroke was visually indistinguishable from the room's
 *  pre-existing zone-floor circles from normal camera distance. Single-
 *  owner zones (no second author — see the file header's "single-owner
 *  calm") get a small, low-contrast name stitched near the edge instead
 *  of the two-tone split, since there's no second colour to do the
 *  telling. */
function rugTexture(ownership) {
  const W = 256, H = 256
  const c = document.createElement('canvas')
  c.width = W; c.height = H
  const g = c.getContext('2d')
  const { topFrac, secondFrac } = rugSplit(ownership)
  const topHex = hairFor(ownership.top.author)
  g.fillStyle = topHex
  g.fillRect(0, 0, W, H)
  if (secondFrac > 0) {
    g.fillStyle = hairFor(ownership.second.author)
    g.fillRect(0, 0, W, H * secondFrac)
  }

  // woven diagonal hatch across the whole fill — the thing a flat tint
  // never had, and the thing that reads as "fabric" instead of "floor
  // paint" even before you're close enough to make out the border.
  g.save()
  g.globalAlpha = 0.16
  g.strokeStyle = '#000000'
  g.lineWidth = 2
  for (let x = -H; x < W + H; x += 12) {
    g.beginPath(); g.moveTo(x, 0); g.lineTo(x + H, H); g.stroke()
  }
  g.globalAlpha = 0.10
  g.strokeStyle = '#ffffff'
  for (let x = -H; x < W + H; x += 12) {
    g.beginPath(); g.moveTo(x + 6, 0); g.lineTo(x + H + 6, H); g.stroke()
  }
  g.restore()

  // braided border: a dark ring set inside a light one, both well outside
  // the old single 3px stroke, so the mat's edge reads as an object
  // sitting on the floor rather than a coloured outline.
  const darkHex = '#' + darken(topHex, 0.55).toString(16).padStart(6, '0')
  g.lineWidth = 10
  g.strokeStyle = darkHex
  g.strokeRect(6, 6, W - 12, H - 12)
  g.lineWidth = 4
  g.strokeStyle = 'rgba(240,236,230,0.9)'
  g.strokeRect(15, 15, W - 30, H - 30)

  if (ownership.authorCount === 1) {
    g.save()
    g.textAlign = 'center'
    g.font = '600 16px ui-monospace, SFMono-Regular, Menlo, monospace'
    g.fillStyle = 'rgba(240,236,230,0.8)'
    g.fillText(ownership.top.author, W / 2, H - 30)
    g.restore()
  }

  void topFrac
  const t = new THREE.CanvasTexture(c)
  t.anisotropy = 8
  return t
}

function buildRug(zoneDef, ownership) {
  const g = new THREE.Group()
  g.name = 'zoneowner-rug'
  // Bigger than round 5's 0.56 — a rug that only covers about a third of
  // its zone's floor circle reads as a rounding error next to that
  // circle, not a distinct object on top of it.
  const r = zoneDef.r * 0.7
  const mesh = new THREE.Mesh(
    new THREE.CircleGeometry(r, 40),
    new THREE.MeshStandardMaterial({ map: rugTexture(ownership), roughness: 1, transparent: true, opacity: 0.97 }),
  )
  mesh.rotation.x = -Math.PI / 2
  mesh.position.set(zoneDef.at[0], 0.052, zoneDef.at[1])
  mesh.receiveShadow = true
  g.add(mesh)

  // A short beveled lip standing a few millimetres proud of the floor —
  // the thing a flat decal can never sell, and cheap here since it's one
  // extra ring per zone. Sits a shade below the fill's darkened border so
  // the two read as one continuous raised edge rather than two objects.
  // Own material rather than solidMat's shared cache — this group gets
  // rebuilt (and disposed) on every poll, and a cache entry disposed out
  // from under a still-cached key would break the next zone that reuses
  // it, the same trap the flourish materials below already carry.
  const lipMat = new THREE.MeshStandardMaterial({
    color: darken(hairFor(ownership.top.author), 0.5), roughness: 0.95,
  })
  const lip = new THREE.Mesh(new THREE.CylinderGeometry(r * 1.03, r, 0.018, 40, 1, true), lipMat)
  lip.position.set(zoneDef.at[0], 0.043, zoneDef.at[1])
  lip.castShadow = true
  lip.receiveShadow = true
  g.add(lip)

  const flourish = buildFlourish(flourishFor(ownership), ownership)
  if (flourish) { flourish.position.set(zoneDef.at[0], 0.06, zoneDef.at[1] + r * 0.55); g.add(flourish) }
  return g
}

function disposeGroup(group) {
  group.traverse((n) => {
    if (!n.isMesh && !n.isSprite) return
    if (n.material) {
      if (n.material.map) n.material.map.dispose()
      n.material.dispose()
    }
    if (n.geometry && n.geometry !== BOX && n.geometry !== CYL && n.geometry !== RING) n.geometry.dispose()
  })
}

void RING // reserved: a ring-border rug variant was tried and dropped, see STATE.md

// ---------------------------------------------------------------------
// attach()
// ---------------------------------------------------------------------

function initialMode() {
  try {
    return new URLSearchParams(location.search).get('zoMode') === 'plaque' ? 'plaque' : 'rug'
  } catch {
    return 'rug' // no `location` outside a browser
  }
}

/**
 * attachZoneOwner({ scene, zoneDirs, fetchFn, intervalMs }) ->
 *   { setZoneOwnership(zoneName, rawShortlogData), setMode(m), mode, dispose() }
 *
 * Self-contained, same shape as histshelf.js's attachHistShelf: runs its
 * own poll loop rather than piggybacking office.html's existing
 * attachGitSignals() call, because that call already lives outside this
 * round's append-only slice of office.html (line ~470, not the trailing
 * wiring fence) and can't be edited to pass a new sink this round.
 * gitsignals.js still grew a matching `ownership` sink on attachGitSignals
 * for a future round to wire through instead of running two pollers — see
 * gitsignals.js's own note and STATE.md's "known duplication" section,
 * same shape of tradeoff as blamecard/histshelf's independent fetchers.
 *
 * `setZoneOwnership` is also exposed directly so a caller (a test, or a
 * future integration) can drive it without a real fetch loop.
 */
export function attachZoneOwner(cfg = {}) {
  const {
    scene = null,
    zoneDirs = {},
    fetchFn = (...a) => fetch(...a),
    intervalMs = 25_000,
  } = cfg

  const root = new THREE.Group()
  root.name = 'zoneowner-root'
  if (scene) scene.add(root)

  let mode = initialMode()
  const state = new Map() // zoneName -> ownership | null
  const groups = new Map() // zoneName -> THREE.Group currently in root
  const _campos = new THREE.Vector3()
  const _worldpos = new THREE.Vector3()

  function render(zoneName) {
    const old = groups.get(zoneName)
    if (old) { root.remove(old); disposeGroup(old) }
    groups.delete(zoneName)
    const zoneDef = ZONES[zoneName]
    const ownership = state.get(zoneName)
    if (!zoneDef || !ownership) return
    const g = mode === 'rug' ? buildRug(zoneDef, ownership) : buildPlaque(zoneDef, ownership)
    root.add(g)
    groups.set(zoneName, g)
  }

  function renderAll() { for (const z of state.keys()) render(z) }

  // Plaques/rugs are sized for the normal wide room shot. Round 3's head-zoom
  // camera flight (office.html, Z) can park the camera a couple of metres
  // from a desk zone's plaque, and a fixed-world-size sprite that close
  // fills most of the frame and bleeds through the DOM cards on top of it —
  // found live, integrating this round. Fade the zone's main prop out as the
  // camera closes in rather than capping its world scale, so it reads as
  // "stepped past the signage" instead of a jump-cut in size.
  const FADE_NEAR = 3.0   // camera distance (m) below which it's fully hidden
  const FADE_FAR = 5.5    // camera distance (m) at/above which it's fully shown
  function updateCamera(camera) {
    if (!camera) return
    _campos.copy(camera.position)
    for (const g of groups.values()) {
      const main = g.children[0]
      if (!main || !main.material) continue
      main.getWorldPosition(_worldpos)
      const d = _campos.distanceTo(_worldpos)
      const t = Math.min(1, Math.max(0, (d - FADE_NEAR) / (FADE_FAR - FADE_NEAR)))
      const base = mode === 'rug' ? 0.97 : 0.97
      main.material.opacity = base * t
      main.visible = t > 0.02
      // rug mode's second child is the raised lip — fades with the mat
      // itself so a close zoom doesn't leave a bare rim floating with no
      // fill under it once the mat's own opacity hits 0.
      const lip = mode === 'rug' ? g.children[1] : null
      if (lip && lip.visible !== undefined) lip.visible = t > 0.02
    }
  }

  /** Feed one zone's raw /api/git/shortlog body straight in — pure
   *  pickOwnership() does the interpreting, this just re-renders. Safe to
   *  call with {ok:false} or a garbage body: that clears the zone's
   *  dressing rather than drawing on stale data. */
  function setZoneOwnership(zoneName, rawShortlogData) {
    state.set(zoneName, pickOwnership(rawShortlogData))
    render(zoneName)
  }

  function setMode(m) {
    mode = m === 'rug' ? 'rug' : 'plaque'
    renderAll()
  }

  function onKeydown(e) {
    if (e.key !== 'u' && e.key !== 'U') return
    const tag = (document.activeElement && document.activeElement.tagName) || ''
    if (tag === 'INPUT' || tag === 'TEXTAREA') return
    setMode(mode === 'plaque' ? 'rug' : 'plaque')
  }
  if (typeof addEventListener === 'function') addEventListener('keydown', onKeydown)

  const dirCache = new Map() // dir -> promise
  function loadDir(dir) {
    if (dirCache.has(dir)) return dirCache.get(dir)
    const p = fetchFn(`/api/git/shortlog?dir=${encodeURIComponent(dir)}`)
      .then((r) => r.json())
      .catch(() => ({ ok: false, reason: 'fetch failed' }))
    dirCache.set(dir, p)
    return p
  }

  // Same guard as histshelf.js's show(): a slow git call can make an
  // earlier tick's fetch land after a later one's, and wall-clock order
  // isn't poll order. Bail before applying if a newer tick already started.
  let reqId = 0
  async function tick() {
    const myReq = ++reqId
    dirCache.clear()
    await Promise.all(Object.entries(zoneDirs).map(async ([zoneName, dir]) => {
      try {
        const data = await loadDir(dir)
        if (myReq !== reqId) return   // a later tick() beat this one home
        setZoneOwnership(zoneName, data)
      } catch {
        if (myReq !== reqId) return
        // a blip clears this zone's dressing rather than showing stale props
        setZoneOwnership(zoneName, null)
      }
    }))
  }

  let timer = null
  if (typeof fetchFn === 'function' && Object.keys(zoneDirs).length) {
    tick()
    timer = setInterval(tick, intervalMs)
  }

  return {
    setZoneOwnership,
    setMode,
    get mode() { return mode },
    tick,
    updateCamera,
    dispose() {
      if (timer) clearInterval(timer)
      if (typeof removeEventListener === 'function') removeEventListener('keydown', onKeydown)
      for (const g of groups.values()) disposeGroup(g)
      groups.clear()
      if (scene) scene.remove(root)
    },
  }
}
