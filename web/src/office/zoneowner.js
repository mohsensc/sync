// Zone ownership as room dressing: turns `git shortlog` per zone into
// physical props instead of the one-line "mostly <name>" text already
// stitched into the zone marker's label (see zones.js's setOwner, wired
// from gitsignals.js's pollZone).
//
// Two treatments behind one key toggle (press U, or load with
// ?zoMode=rug — 'plaque' is the default):
//   'plaque' — a wall-style sign floating over the zone, owner's name in
//     their palette hair colour, sized by commit share.
//   'rug'    — a floor mat tinted by the owner's colour with a second
//     woven stripe for the runner-up.
// Both modes also get an ambient flourish when the numbers are lopsided
// enough to say something with a prop instead of a label: a trophy for a
// zone one human clearly owns (>=80% share), two mugs side by side for one
// that's genuinely split. Anything in between gets dressing but no
// flourish — most zones most of the time, and that's fine, not everything
// needs to shout.
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
  g.fillText(`${Math.round(ownership.top.share * 100)}% of this area`, W / 2, 130)

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
 *  edge if there is a second author, a plain undyed border either way so
 *  it reads as a mat and not a paint swatch. */
function rugTexture(ownership) {
  const W = 256, H = 256
  const c = document.createElement('canvas')
  c.width = W; c.height = H
  const g = c.getContext('2d')
  const { topFrac, secondFrac } = rugSplit(ownership)
  g.fillStyle = hairFor(ownership.top.author)
  g.fillRect(0, 0, W, H)
  if (secondFrac > 0) {
    g.fillStyle = hairFor(ownership.second.author)
    g.fillRect(0, 0, W, H * secondFrac)
  }
  // undyed woven border
  g.strokeStyle = 'rgba(240,236,230,0.85)'
  g.lineWidth = 14
  g.strokeRect(7, 7, W - 14, H - 14)
  void topFrac
  const t = new THREE.CanvasTexture(c)
  t.anisotropy = 8
  return t
}

function buildRug(zoneDef, ownership) {
  const g = new THREE.Group()
  g.name = 'zoneowner-rug'
  const r = zoneDef.r * 0.56
  const mesh = new THREE.Mesh(
    new THREE.CircleGeometry(r, 40),
    new THREE.MeshStandardMaterial({ map: rugTexture(ownership), roughness: 1, transparent: true, opacity: 0.92 }),
  )
  mesh.rotation.x = -Math.PI / 2
  mesh.position.set(zoneDef.at[0], 0.05, zoneDef.at[1])
  mesh.receiveShadow = true
  g.add(mesh)
  const flourish = buildFlourish(flourishFor(ownership), ownership)
  if (flourish) { flourish.position.set(zoneDef.at[0], 0.05, zoneDef.at[1] + r * 0.55); g.add(flourish) }
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
    return new URLSearchParams(location.search).get('zoMode') === 'rug' ? 'rug' : 'plaque'
  } catch {
    return 'plaque' // no `location` outside a browser
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
      const base = mode === 'rug' ? 0.92 : 0.97
      main.material.opacity = base * t
      main.visible = t > 0.02
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

  async function tick() {
    dirCache.clear()
    await Promise.all(Object.entries(zoneDirs).map(async ([zoneName, dir]) => {
      try {
        const data = await loadDir(dir)
        setZoneOwnership(zoneName, data)
      } catch {
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
