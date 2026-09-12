// Commit board: the whole repo's recent history as a wall prop, mounted by
// reception (the "incoming work" zone — see zones.js's ZONES.reception) so
// it reads as a noticeboard by the front desk rather than a stat panel.
//
// Data: /api/git/recent?count=<n>, repo-wide (no path/dir filter — see
// gitapi.mjs's `recent` route), returns up to `count` commits newest-first
// with subject, deduped author (same email-based merge shortlog/blame use),
// relative age in days, and a files-touched count. This is a genuinely
// different fetcher from gitsignals.js/zoneowner.js/histshelf.js's — those
// are all per-file or per-dir, this is the only repo-wide one — so it gets
// its own small poll loop rather than piggybacking any of theirs. Same
// "several independent, all-cheap git fetchers" shape STATE.md has
// documented since round 2.
//
// Three treatments behind one key toggle (press N, or load with
// ?board=ticker / ?board=stickies — 'departures' is the default):
//   'departures' — airport-board rows, newest on top. New rows flip in on a
//     hinge with a per-row stagger, same "motion sells it" instinct
//     zoneowner.js's fade-by-distance and ghost.js's sway are built on —
//     see the file's own note on why mechanical pop-in reads as cheap.
//   'ticker'     — one scrolling line along the board's bottom edge,
//     subjects separated by a middle dot. Cheapest to read at a glance,
//     costs the least screen space.
//   'stickies'   — a grid of sticky notes, one per commit, tinted by the
//     author's hair colour (hairFor below) so a glance at the board tells
//     you who's been busy without reading a single word.
//
// Degrade rule: no commits (route unreachable, or truly nothing in the
// window) renders one calm plate reading "quiet in here" — never a blank
// board, which reads as broken rather than empty.

import * as THREE from 'three'
import { ZONES } from './zones.js'

// ---------------------------------------------------------------------
// Colour: re-hosted hash, same swatches/algorithm as palette.ts's hairFor.
// office/*.js is unbundled plain JS and can't import the .ts side — every
// consumer on this side (live.js, zones.js, zoneowner.js, history-viz.js)
// already carries its own copy for the same reason; this is a fourth, not
// an oversight. Kept identical to zoneowner.js's HAIR_COLORS rather than
// importing it, on the theory that a wall prop's colour key shouldn't
// silently drift if zoneowner.js's copy ever changes for its own reasons.
// ---------------------------------------------------------------------

export const HAIR_COLORS = [
  '#D9714F', // terracotta
  '#8A94A3', // slateBlue
  '#D6B45C', // mustard
  '#A5738C', // mauve
  '#B0674F', // coffee
  '#E8946C', // salmon
]

export function hairFor(human) {
  let h = 0
  const s = String(human || '')
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0
  return HAIR_COLORS[h % HAIR_COLORS.length]
}

// ---------------------------------------------------------------------
// Pure data shaping. No DOM, no THREE — testable without a renderer, same
// split histshelf.js's spineFor()/layoutShelf() use.
// ---------------------------------------------------------------------

export const EMPTY_MESSAGE = 'quiet in here'
export const MAX_ROWS = 8
export const ROW_HEIGHT = 0.19 // metres between stacked departure rows — 8 rows have to clear BOARD_H below the header, see buildDepartures
export const STICKY_COLS = 4
export const STICKY_CELL = 0.30 // metres, sticky grid pitch

/** ageDays -> a short label. Same buckets histshelf/blamecard reach for
 *  (days, then months, then years) rather than a fourth phrasing for the
 *  same numbers — see history-viz.js's parseRelativeAge for the inverse
 *  direction (git's own relative string -> days) this doesn't need here,
 *  since gitapi.mjs already hands back a number. */
export function formatAge(ageDays) {
  if (ageDays == null || !Number.isFinite(ageDays)) return ''
  if (ageDays <= 0) return 'today'
  if (ageDays === 1) return '1d ago'
  if (ageDays < 30) return `${ageDays}d ago`
  const months = Math.round(ageDays / 30)
  if (months < 12) return `${months}mo ago`
  return `${Math.round(ageDays / 365)}y ago`
}

/** /api/git/recent's body -> up to `max` display rows, newest first (the
 *  route already returns newest-first; nothing here re-sorts, unlike
 *  zoneowner's pickOwnership, since there's no second source to merge
 *  against). {ok:false} or a garbage body -> [], same "absent means
 *  unknown" contract as pickOwnership/statToAgeDays. */
export function shapeRows(data, max = MAX_ROWS) {
  if (!data || data.ok !== true || !Array.isArray(data.entries)) return []
  return data.entries.slice(0, max).map((e, i) => {
    const subject = String((e && e.subject) || '').trim()
    return {
      sha: String((e && e.sha) || `row${i}`),
      author: String((e && e.author) || 'unknown'),
      subject: subject || '(no subject)',
      ageDays: Number.isFinite(e && e.ageDays) ? e.ageDays : null,
      ageLabel: formatAge(e && e.ageDays),
      files: Number.isFinite(e && e.files) ? e.files : 0,
    }
  })
}

/** Departures layout: newest row at the top (y = 0), each older row one
 *  ROW_HEIGHT further down. Pure so a test can check stacking order and
 *  spacing without touching a THREE.Mesh. */
export function rowLayout(rows, rowHeight = ROW_HEIGHT) {
  return rows.map((r, i) => ({ sha: r.sha, y: -i * rowHeight }))
}

/** Ticker text: subjects newest-first, joined by a middle dot. Empty rows
 *  -> EMPTY_MESSAGE, same copy the 3D degrade case uses, so every
 *  treatment says the same thing when there's nothing to show. */
export function tickerText(rows) {
  if (!rows || rows.length === 0) return EMPTY_MESSAGE
  return rows.map((r) => r.subject).join('   ·   ')
}

/** Sticky grid layout: row-major, centred column-wise around x=0. Pure
 *  position math — the actual note mesh/texture is stickyBuild()'s job. */
export function stickyGridLayout(count, cols = STICKY_COLS, cell = STICKY_CELL) {
  const out = []
  for (let i = 0; i < count; i++) {
    const col = i % cols
    const row = Math.floor(i / cols)
    out.push({ x: (col - (cols - 1) / 2) * cell, y: -row * cell })
  }
  return out
}

/** Sticky note colour: the author's hair swatch, so a glance at the grid
 *  reads "who's been busy" by colour alone. Exposed separately from
 *  hairFor so a test can assert the assignment without re-deriving the
 *  hash by hand. */
export function stickyColor(author) {
  return hairFor(author)
}

// ---------------------------------------------------------------------
// 3D building blocks
// ---------------------------------------------------------------------

const BOARD_W = 0.95   // metres, board face width (world Z once mounted)
const BOARD_H = 1.90   // metres, board face height (world Y) — sized so MAX_ROWS
                        // departure rows at ROW_HEIGHT spacing clear the bottom
                        // edge below the header; see buildDepartures
const PANEL_GEO = new THREE.PlaneGeometry(1, 1)

const matCache = new Map()
function cachedMat(key, factory) {
  if (!matCache.has(key)) matCache.set(key, factory())
  return matCache.get(key)
}

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

/** The wall-mounted backing plate + frame + header plate. Built once per
 *  attach() call and reused across mode/data changes — only the content in
 *  front of it (rows/ticker/stickies) gets rebuilt. */
function buildBacking(mountX) {
  const g = new THREE.Group()
  g.name = 'commitboard-backing'

  const frame = new THREE.Mesh(
    new THREE.BoxGeometry(0.05, BOARD_H + 0.14, BOARD_W + 0.14),
    cachedMat('cb-frame', () => new THREE.MeshStandardMaterial({ color: 0x6b5f56, roughness: 0.85 })),
  )
  frame.position.set(mountX + 0.02, 1.55, 0)
  frame.castShadow = true
  g.add(frame)

  const face = new THREE.Mesh(
    new THREE.BoxGeometry(0.03, BOARD_H, BOARD_W),
    cachedMat('cb-face', () => new THREE.MeshStandardMaterial({ color: 0x3a4250, roughness: 0.7 })),
  )
  face.position.set(mountX + 0.045, 1.55, 0)
  face.receiveShadow = true
  g.add(face)

  const headerCanvas = document.createElement('canvas')
  headerCanvas.width = 512; headerCanvas.height = 96
  const hg = headerCanvas.getContext('2d')
  roundRectPath(hg, 4, 4, 504, 88, 14)
  hg.fillStyle = '#D6B45C'; hg.fill()
  hg.textAlign = 'center'; hg.textBaseline = 'middle'
  hg.fillStyle = '#35455C'
  hg.font = '700 40px ui-sans-serif, -apple-system, Segoe UI, sans-serif'
  hg.fillText('RECENT COMMITS', 256, 50)
  const headerTex = new THREE.CanvasTexture(headerCanvas)
  headerTex.anisotropy = 8
  const header = new THREE.Mesh(
    PANEL_GEO.clone(),
    new THREE.MeshBasicMaterial({ map: headerTex, transparent: true }),
  )
  header.rotation.y = Math.PI / 2
  header.scale.set(BOARD_W * 0.92, 0.16, 1)
  header.position.set(mountX + 0.062, 1.55 + BOARD_H / 2 - 0.12, 0)
  header.renderOrder = 10
  g.add(header)

  return g
}

function panel(mountX, y, z, w, h, texture, opts = {}) {
  const m = new THREE.Mesh(
    PANEL_GEO.clone(),
    new THREE.MeshBasicMaterial({ map: texture, transparent: true, ...opts }),
  )
  m.rotation.y = Math.PI / 2
  m.scale.set(w, h, 1)
  m.position.set(mountX + 0.062, y, z)
  m.renderOrder = 10
  return m
}

function emptyPanel(mountX) {
  const c = document.createElement('canvas')
  c.width = 480; c.height = 160
  const g = c.getContext('2d')
  g.textAlign = 'center'; g.textBaseline = 'middle'
  g.fillStyle = '#8A94A3'
  g.font = 'italic 30px ui-sans-serif, -apple-system, Segoe UI, sans-serif'
  g.fillText(EMPTY_MESSAGE, 240, 80)
  const tex = new THREE.CanvasTexture(c)
  tex.anisotropy = 8
  const grp = new THREE.Group()
  grp.name = 'commitboard-empty'
  grp.add(panel(mountX, 1.55, 0, BOARD_W * 0.85, 0.28, tex))
  return grp
}

function rowCanvas(row) {
  const W = 640, H = 128
  const c = document.createElement('canvas')
  c.width = W; c.height = H
  const g = c.getContext('2d')
  roundRectPath(g, 3, 3, W - 6, H - 6, 12)
  g.fillStyle = '#2c3340'; g.fill()

  const dotColor = hairFor(row.author)
  g.beginPath(); g.arc(40, H / 2, 14, 0, Math.PI * 2)
  g.fillStyle = dotColor; g.fill()

  g.textAlign = 'left'; g.textBaseline = 'middle'
  g.fillStyle = '#F0ECE6'
  g.font = '600 34px ui-monospace, SFMono-Regular, Menlo, monospace'
  const subject = row.subject.length > 34 ? row.subject.slice(0, 33) + '…' : row.subject
  g.fillText(subject, 72, H / 2 - 16)

  g.fillStyle = '#B7C0CC'
  g.font = '400 24px ui-monospace, SFMono-Regular, Menlo, monospace'
  g.fillText(`${row.author}  ·  ${row.ageLabel || '—'}`, 72, H / 2 + 20)

  const tex = new THREE.CanvasTexture(c)
  tex.anisotropy = 8
  return tex
}

/** 'departures' content: one plane per row, stacked per rowLayout(). Rows
 *  whose sha is in `freshShas` start hinge-folded (rotation.x near flat)
 *  and carry animation state in userData for update() to ease open —
 *  built here, driven per-frame by the returned handle's update(dt). */
function buildDepartures(mountX, rows, freshShas) {
  const g = new THREE.Group()
  g.name = 'commitboard-departures'
  if (rows.length === 0) { g.add(emptyPanel(mountX)); return g }
  const layout = rowLayout(rows)
  const top = 1.55 + BOARD_H / 2 - 0.30
  rows.forEach((row, i) => {
    const mesh = panel(mountX, top + layout[i].y, 0, BOARD_W * 0.90, ROW_HEIGHT * 0.86, rowCanvas(row))
    const fresh = freshShas && freshShas.has(row.sha)
    mesh.userData.flip = fresh
      ? { t: 0, delay: i * 0.07, duration: 0.42 }
      : null
    if (fresh) mesh.rotation.x = -1.3
    g.add(mesh)
  })
  return g
}

function tickerCanvas(text) {
  const W = 1600, H = 96
  const c = document.createElement('canvas')
  c.width = W; c.height = H
  const g = c.getContext('2d')
  g.fillStyle = '#2c3340'; g.fillRect(0, 0, W, H)
  g.textAlign = 'left'; g.textBaseline = 'middle'
  g.fillStyle = '#F0ECE6'
  g.font = '600 40px ui-monospace, SFMono-Regular, Menlo, monospace'
  // Draw the line twice back to back so a scrolling UV offset never shows
  // a seam — the same trick a physical ticker's looped belt uses.
  const full = '   ' + text + '   '
  g.fillText(full, 0, H / 2)
  const w1 = g.measureText(full).width || W / 2
  g.fillText(full, w1, H / 2)
  const tex = new THREE.CanvasTexture(c)
  tex.wrapS = THREE.RepeatWrapping
  tex.wrapT = THREE.ClampToEdgeWrapping
  tex.repeat.set(W / Math.max(1, w1), 1)
  tex.anisotropy = 8
  return { tex, unitWidth: w1 / W }
}

/** 'ticker' content: a single scrolling strip along the board's bottom
 *  edge. Scroll speed is metres-of-text per second at the mesh's own
 *  world scale — update() advances tex.offset.x each frame. */
function buildTicker(mountX, rows) {
  const g = new THREE.Group()
  g.name = 'commitboard-ticker'
  if (rows.length === 0) { g.add(emptyPanel(mountX)); return g }
  const { tex, unitWidth } = tickerCanvas(tickerText(rows))
  const mesh = panel(mountX, 1.55 - BOARD_H / 2 + 0.16, 0, BOARD_W * 0.94, 0.18, tex)
  mesh.userData.ticker = { unitWidth }
  g.add(mesh)
  return g
}

function stickyCanvas(row) {
  const W = 220, H = 220
  const c = document.createElement('canvas')
  c.width = W; c.height = H
  const g = c.getContext('2d')
  g.fillStyle = stickyColor(row.author)
  g.fillRect(0, 0, W, H)
  g.fillStyle = 'rgba(0,0,0,0.12)'
  g.fillRect(0, H - 10, W, 10) // dog-eared shadow along the bottom
  g.fillStyle = '#2c2c2c'
  g.textAlign = 'left'; g.textBaseline = 'top'
  g.font = '600 20px ui-sans-serif, -apple-system, Segoe UI, sans-serif'
  const words = row.subject.split(' ')
  let line = '', y = 18
  const lines = []
  for (const w of words) {
    const test = line ? line + ' ' + w : w
    if (g.measureText(test).width > W - 24 && line) { lines.push(line); line = w } else { line = test }
  }
  if (line) lines.push(line)
  for (const l of lines.slice(0, 5)) { g.fillText(l, 12, y); y += 26 }
  g.font = '500 15px ui-sans-serif, -apple-system, Segoe UI, sans-serif'
  g.fillStyle = 'rgba(0,0,0,0.55)'
  g.fillText(`${row.author} · ${row.ageLabel || '—'}`, 12, H - 30)
  const tex = new THREE.CanvasTexture(c)
  tex.anisotropy = 8
  return tex
}

/** 'stickies' content: a grid of tinted notes, one per commit. */
function buildStickies(mountX, rows) {
  const g = new THREE.Group()
  g.name = 'commitboard-stickies'
  if (rows.length === 0) { g.add(emptyPanel(mountX)); return g }
  const layout = stickyGridLayout(rows.length)
  const top = 1.55 + BOARD_H / 2 - 0.42
  rows.forEach((row, i) => {
    const mesh = panel(mountX, top + layout[i].y, layout[i].x, STICKY_CELL * 0.92, STICKY_CELL * 0.92, stickyCanvas(row))
    mesh.rotation.z = ((i * 37) % 9 - 4) * 0.02 // a hair of scatter so the grid doesn't read as printed
    g.add(mesh)
  })
  return g
}

function disposeGroup(group) {
  group.traverse((n) => {
    if (!n.isMesh) return
    if (n.material) {
      if (n.material.map) n.material.map.dispose()
      n.material.dispose()
    }
    if (n.geometry !== PANEL_GEO) n.geometry.dispose()
  })
}

// ---------------------------------------------------------------------
// attach()
// ---------------------------------------------------------------------

function initialMode() {
  try {
    const m = new URLSearchParams(location.search).get('board')
    return m === 'ticker' || m === 'stickies' ? m : 'departures'
  } catch {
    return 'departures' // no `location` outside a browser
  }
}

/**
 * attachCommitBoard({ scene, fetchFn, intervalMs, count, mountX }) ->
 *   { setEntries(rawRecentData), setMode(m), mode, tick, update(dt),
 *     dispose() }
 *
 * Self-contained: own poll loop (like zoneowner.js's attachZoneOwner) and
 * own render-frame animation loop (like gitsignals.js's churn wisps) so
 * office.html's wiring block only has to call this once and stash the
 * handle — nothing in the main render loop needs editing to drive it.
 */
export function attachCommitBoard(cfg = {}) {
  const {
    scene = null,
    fetchFn = (...a) => fetch(...a),
    intervalMs = 30_000,
    count = MAX_ROWS,
    // Left wall default, same value dressing.js's buildDressing() falls
    // back to when office.html doesn't override it — kept as a literal
    // here rather than importing dressing.js, which this round's task
    // split leaves owned by a different task.
    mountX = -8.83,
  } = cfg

  const root = new THREE.Group()
  root.name = 'commitboard-root'
  root.add(buildBacking(mountX))
  const zoneDef = ZONES.reception
  if (zoneDef) root.position.set(0, 0, zoneDef.at[1])
  if (scene) scene.add(root)

  let mode = initialMode()
  let rows = []
  const seenShas = new Set()
  let content = new THREE.Group()
  root.add(content)

  function rebuildContent(freshShas) {
    root.remove(content)
    disposeGroup(content)
    content = mode === 'ticker' ? buildTicker(mountX, rows)
      : mode === 'stickies' ? buildStickies(mountX, rows)
        : buildDepartures(mountX, rows, freshShas || new Set())
    root.add(content)
  }

  /** Feed one /api/git/recent body straight in — shapeRows() does the
   *  interpreting, this just re-renders. Safe to call with {ok:false} or a
   *  garbage body: that clears to the "quiet in here" plate rather than
   *  drawing on stale data. */
  function setEntries(data) {
    const nextRows = shapeRows(data, count)
    // Only flip-animate genuinely new commits, and only once seenShas has
    // something in it — the very first load has nothing to compare
    // against, and flip-animating every row in on page load is exactly
    // the "mechanical pop-in reads as cheap" case the header warns about.
    const hadPrior = seenShas.size > 0
    const fresh = new Set(hadPrior ? nextRows.filter((r) => !seenShas.has(r.sha)).map((r) => r.sha) : [])
    for (const r of nextRows) seenShas.add(r.sha)
    rows = nextRows
    rebuildContent(fresh)
  }

  function setMode(m) {
    mode = m === 'ticker' || m === 'stickies' ? m : 'departures'
    rebuildContent(new Set())
  }

  function onKeydown(e) {
    if (e.key !== 'n' && e.key !== 'N') return
    const tag = (document.activeElement && document.activeElement.tagName) || ''
    if (tag === 'INPUT' || tag === 'TEXTAREA') return
    const order = ['departures', 'ticker', 'stickies']
    setMode(order[(order.indexOf(mode) + 1) % order.length])
  }
  if (typeof addEventListener === 'function') addEventListener('keydown', onKeydown)

  // ---- per-frame animation: departures flip-in, ticker scroll ----
  const TICKER_SPEED = 0.18 // texture-unit-widths per second
  function update(dt) {
    if (!content) return
    for (const mesh of content.children) {
      if (mesh.userData.flip) {
        const f = mesh.userData.flip
        f.t += dt
        const p = Math.max(0, Math.min(1, (f.t - f.delay) / f.duration))
        if (p > 0) {
          // ease-out-back-ish: overshoots slightly past flat then settles,
          // reads less mechanical than a linear unfold.
          const eased = 1 - Math.pow(1 - p, 3)
          mesh.rotation.x = -1.3 * (1 - eased)
          if (p >= 1) mesh.userData.flip = null
        }
      }
      if (mesh.userData.ticker) {
        const tex = mesh.material.map
        if (tex) tex.offset.x = (tex.offset.x + dt * TICKER_SPEED) % 1
      }
    }
  }

  let raf = null
  let last = 0
  function frame(now) {
    const dt = last ? Math.min(0.1, (now - last) / 1000) : 0
    last = now
    update(dt)
    raf = requestAnimationFrame(frame)
  }
  if (typeof requestAnimationFrame === 'function') raf = requestAnimationFrame(frame)

  async function tick() {
    try {
      const r = await fetchFn(`/api/git/recent?count=${count}`)
      const data = await r.json()
      setEntries(data)
    } catch {
      setEntries(null) // a blip clears to "quiet in here" rather than showing stale rows
    }
  }

  let timer = null
  if (typeof fetchFn === 'function') {
    tick()
    timer = setInterval(tick, intervalMs)
  }

  return {
    setEntries,
    setMode,
    get mode() { return mode },
    get rows() { return rows },
    tick,
    update,
    dispose() {
      if (timer) clearInterval(timer)
      if (raf != null && typeof cancelAnimationFrame === 'function') cancelAnimationFrame(raf)
      if (typeof removeEventListener === 'function') removeEventListener('keydown', onKeydown)
      disposeGroup(content)
      disposeGroup(root.children[0]) // backing
      if (scene) scene.remove(root)
    },
  }
}
