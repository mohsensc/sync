// File history as a bookshelf: turns /api/git/log for the selected agent's
// file into a physical row of book spines floating near their desk. One
// spine per commit, newest nearest the agent, height/lean tracking age.
//
// Two treatments behind one key toggle (press H, or load with
// ?hsMode=strip): "3d" builds thin boxes in the scene itself; "strip" is a
// flat DOM film-strip pinned in screen space over the agent's head. Same
// layout math (layoutShelf below) drives both, so switching treatments
// never re-fetches or re-derives anything, just re-renders.
//
// Data: /api/git/log?path=...&n=12, same response shape blamecard.js's
// loadFor() already consumes ({ ok, entries: [{ sha, author, when,
// subject }] }, newest first — git log's default order, no --reverse).
// Kept as its own fetch/cache here rather than sharing blamecard's: the
// two panels have independent lifecycles (the shelf only exists while ITS
// treatment is on screen, the card lives whenever anything is selected)
// and different `n`. STATE.md has flagged this duplication pattern before
// as fine-to-leave — three git fetchers with no shared cache, all cheap,
// all local. Not collapsing it here either.
//
// Degrade rule: 0 commits at this path renders nothing (not an empty
// shelf), 1 commit renders a single "dusty tome" lying flat instead of a
// shelf that looks broken with one spine on it.

import { colorForAuthor, hueForAuthor, parseRelativeAge, ageToX } from './history-viz.js'
import * as THREE from 'three'

// ---------------------------------------------------------------------
// Pure layout. No DOM, no THREE object creation — just numbers, so both
// histshelf.test.ts (vitest) and histshelf-test.html (eyeballing) can
// exercise the same math without a renderer.
// ---------------------------------------------------------------------

export const SPINE = {
  minHeight: 0.16,    // metres — oldest commit in the batch
  maxHeight: 0.40,    // metres — newest commit in the batch
  maxLean: 0.30,       // radians — newest leans like it was just slid back in
  spacing: 0.052,      // metres between spine centres, 3D treatment
  width: 0.030,        // metres, spine thickness
  maxSpines: 12,
}

/** One /api/git/log entry -> everything a renderer needs to place and
 *  colour its spine. `t` is 0 (oldest of this batch) .. 1 (newest); height
 *  and lean both derive from it so the two treatments never disagree. */
export function spineFor(entry, maxDays) {
  const when = (entry && entry.when) || ''
  const author = (entry && entry.author) || 'unknown'
  const ageDays = parseRelativeAge(when)
  const t = ageToX(ageDays, maxDays)
  return {
    sha: (entry && entry.sha) || '',
    author,
    subject: (entry && entry.subject) || '',
    when,
    ageDays,
    t,
    height: SPINE.minHeight + t * (SPINE.maxHeight - SPINE.minHeight),
    lean: SPINE.maxLean * t,
    color: colorForAuthor(author),
  }
}

/** entries -> { empty, single, spines, count, maxDays }. `empty` means
 *  render nothing; `single` means render the dusty-tome fallback instead
 *  of a one-spine shelf. `spines` is always newest-first, matching the
 *  git log order entries already arrive in. */
export function layoutShelf(entries, opts = {}) {
  const maxSpines = opts.maxSpines ?? SPINE.maxSpines
  const list = Array.isArray(entries) ? entries.slice(0, maxSpines) : []
  if (list.length === 0) return { empty: true, single: false, spines: [], count: 0, maxDays: 0 }
  const known = list.map(e => parseRelativeAge(e && e.when)).filter(d => d != null)
  const maxDays = known.length ? Math.max(1, ...known) : 1
  const spines = list.map((e, i) => ({ ...spineFor(e, maxDays), index: i }))
  return { empty: false, single: list.length === 1, spines, count: list.length, maxDays }
}

/** x-offset of spine `index` from the near (newest) end of the row. */
export function spineOffset(index, spacing = SPINE.spacing) {
  return index * spacing
}

/** Total footprint of a laid-out row, for sizing the shelf plank / strip. */
export function shelfWidth(layout, spacing = SPINE.spacing) {
  if (!layout || layout.empty || layout.single) return 0
  return layout.spines.length * spacing
}

// ---------------------------------------------------------------------
// 3D treatment
// ---------------------------------------------------------------------

const SHELF_Y = 2.02       // just clears a 1.68m character's head
// Heuristic, not geometry: push the shelf away from the room's centre
// aisle toward whichever wall is nearer. Both desk rows in office.html
// today back onto opposite walls (z=-2.4 row faces the aisle from the
// back wall side, z=1.4 row faces it from the front), so "away from
// centre" reads as "behind the desk" for every seat that exists right
// now. If a future desk ever sits sideways-on this needs a real per-desk
// back-vector instead of a z-sign guess — cheap to swap out, not done
// here since nothing in the current layout needs it.
const SHELF_Z_PUSH = 0.34
const PLANK_DEPTH = 0.16

let sharedGeo = null
function boxGeo() {
  if (!sharedGeo) sharedGeo = new THREE.BoxGeometry(1, 1, 1)
  return sharedGeo
}

/** Same hue formula as colorForAuthor (history-viz.js), just returned as a
 *  THREE.Color via setHSL instead of an hsl() CSS string — three@0.170's
 *  Color.setStyle only parses the comma'd classic hsl() syntax, not the
 *  space-separated one colorForAuthor emits, so this skips the round trip
 *  rather than reformatting a string just to reparse it. */
function authorColor3D(name) {
  return new THREE.Color().setHSL(hueForAuthor(name) / 360, 0.46, 0.52)
}

function tintedMat(color) {
  return new THREE.MeshStandardMaterial({ color, roughness: 0.72, metalness: 0 })
}

/** A single worn book, lying flat rather than standing — the fallback for
 *  0-or-1 commits. One commit doesn't earn a shelf, it earns a book
 *  someone left face-down; a dusty translucent cap says "not touched
 *  much" even before anyone reads the tooltip. */
function buildDustyTome(spine) {
  const g = new THREE.Group()
  g.name = 'histshelf-tome'
  const base = new THREE.Mesh(boxGeo(), tintedMat(spine ? authorColor3D(spine.author) : 0xC3B39B))
  base.scale.set(0.20, 0.05, 0.15)
  base.position.set(0, 0.025, 0)
  base.castShadow = true
  base.receiveShadow = true
  const dust = new THREE.Mesh(boxGeo(), new THREE.MeshStandardMaterial({
    color: 0xE9E0CE, roughness: 1, transparent: true, opacity: 0.55,
  }))
  dust.scale.set(0.205, 0.008, 0.155)
  dust.position.set(0, 0.052, 0)
  g.add(base, dust)
  if (spine) g.userData.spine = spine
  return g
}

/** Builds the "3D spines" treatment as a detached group: a thin plank with
 *  one box per commit, newest nearest the row's near end (x=0 side),
 *  leaning more the newer they are. Geometry is shared across every spine
 *  (boxGeo(), scaled per instance) the same way dressing.js shares BOX/CYL
 *  across ~120 meshes — only materials vary, one per author colour. */
export function buildSpines3D(layout) {
  const group = new THREE.Group()
  group.name = 'histshelf-3d'
  if (!layout || layout.empty) return group
  if (layout.single) { group.add(buildDustyTome(layout.spines[0])); return group }

  const totalW = shelfWidth(layout)
  const plankW = Math.max(0.30, totalW + 0.06)
  const plank = new THREE.Mesh(
    new THREE.BoxGeometry(plankW, 0.02, PLANK_DEPTH),
    new THREE.MeshStandardMaterial({ color: 0x8A94A3, roughness: 0.95 }),
  )
  plank.castShadow = true
  plank.receiveShadow = true
  group.add(plank)

  layout.spines.forEach(s => {
    const mesh = new THREE.Mesh(boxGeo(), tintedMat(authorColor3D(s.author)))
    mesh.scale.set(SPINE.width, s.height, PLANK_DEPTH * 0.78)
    const x = -totalW / 2 + spineOffset(s.index) + SPINE.spacing / 2
    mesh.position.set(x, s.height / 2 + 0.01, 0)
    mesh.rotation.z = -s.lean
    mesh.castShadow = true
    mesh.userData.spine = s
    group.add(mesh)
  })
  return group
}

function disposeGroup(group) {
  group.traverse(n => {
    if (!n.isMesh) return
    // sharedGeo is reused across every spine/tome — never dispose it here,
    // only the plank's own one-off BoxGeometry and every material.
    if (n.geometry && n.geometry !== sharedGeo) n.geometry.dispose()
    n.material?.dispose?.()
  })
}

function shelfPosition(agent) {
  const z = agent.pos.z + (agent.pos.z >= 0 ? SHELF_Z_PUSH : -SHELF_Z_PUSH)
  return [agent.pos.x, SHELF_Y, z]
}

// ---------------------------------------------------------------------
// DOM film-strip treatment
// ---------------------------------------------------------------------

const STRIP_CSS = `
#hshelf{position:fixed;pointer-events:none;display:flex;align-items:flex-end;
  gap:2px;padding:5px 7px 6px;background:#fffdfaee;border:1px solid #C3B39B;
  border-radius:8px 8px 4px 4px;box-shadow:0 8px 20px #4a1f3d22;
  transform:translate(-50%,-100%);opacity:0;transition:opacity .3s ease;z-index:6}
#hshelf.on{opacity:1}
#hshelf .spine{width:7px;border-radius:2px 2px 1px 1px;
  transition:height .4s cubic-bezier(.2,.8,.2,1)}
#hshelf .tome{width:28px;height:9px;border-radius:2px;background:#C3B39B;opacity:.85}
`

/** repo-relative path -> {x,y} on screen, same maths as interact.js's own
 *  project() (kept local rather than shared: this file only needs the one
 *  call, importing interact.js here would pull in a much bigger module for
 *  one 4-line function). */
function projectToScreen(camera, canvas, worldPos) {
  const v = new THREE.Vector3(worldPos[0], worldPos[1], worldPos[2]).project(camera)
  const r = canvas.getBoundingClientRect()
  return [r.left + (v.x * 0.5 + 0.5) * r.width, r.top + (-v.y * 0.5 + 0.5) * r.height]
}

function renderFilmStrip(el, layout) {
  el.innerHTML = ''
  if (!layout || layout.empty) { el.classList.remove('on'); return }
  el.classList.add('on')
  if (layout.single) {
    const s = layout.spines[0]
    const t = document.createElement('div')
    t.className = 'tome'
    t.title = `${s.author} · ${s.subject} (${s.when})`
    el.appendChild(t)
    return
  }
  // 3D lays newest at the near (x=0-ish) end of the row; the strip reads
  // left-to-right, so newest goes rightmost, closest to where the strip
  // hangs over the agent's head — same "nearest the agent" intent, mirrored
  // for how a line of text reads instead of a row in 3D space.
  ;[...layout.spines].reverse().forEach(s => {
    const bar = document.createElement('div')
    bar.className = 'spine'
    bar.style.height = Math.round(10 + s.t * 26) + 'px'
    bar.style.background = s.color
    bar.title = `${s.author} · ${s.subject} (${s.when})`
    el.appendChild(bar)
  })
}

// ---------------------------------------------------------------------
// attach()
// ---------------------------------------------------------------------

function initialMode() {
  try {
    const q = new URLSearchParams(location.search).get('hsMode')
    return q === 'strip' ? 'strip' : '3d'
  } catch {
    return '3d'   // no `location` in a non-browser test context
  }
}

/**
 * attachHistShelf({ scene, camera, canvas, fetchFn }) ->
 *   { show(agent), hide(), setMode(m), mode, dispose() }
 *
 * Self-contained: runs its own rAF loop to keep the DOM strip pinned over
 * a moving agent, rather than hooking into office.html's tick() — this
 * round's file-ownership split has office.html as a shared, append-only
 * file, so the wiring block at its end can attach this and nothing more.
 */
export function attachHistShelf(cfg = {}) {
  const { scene = null, camera = null, canvas = null, fetchFn = (...a) => fetch(...a) } = cfg

  const style = document.createElement('style')
  style.textContent = STRIP_CSS
  document.head.appendChild(style)
  const stripEl = document.createElement('div')
  stripEl.id = 'hshelf'
  document.body.appendChild(stripEl)

  const group3D = new THREE.Group()
  group3D.name = 'histshelf-root'
  group3D.visible = false
  if (scene) scene.add(group3D)

  let mode = initialMode()
  let current = null   // { agent, layout }
  let reqId = 0

  const cache = new Map()
  function loadLog(path) {
    if (!path) return Promise.resolve({ ok: false })
    if (cache.has(path)) return cache.get(path)
    const p = fetchFn(`/api/git/log?path=${encodeURIComponent(path)}&n=${SPINE.maxSpines}`)
      .then(r => r.json())
      .catch(() => ({ ok: false, reason: 'fetch failed' }))
    cache.set(path, p)
    return p
  }

  function clearGroup3D() {
    while (group3D.children.length) {
      const c = group3D.children.pop()
      disposeGroup(c)
    }
  }

  function render() {
    clearGroup3D()
    if (!current) {
      stripEl.classList.remove('on')
      group3D.visible = false
      return
    }
    const { agent, layout } = current
    if (mode === 'strip') {
      group3D.visible = false
      renderFilmStrip(stripEl, layout)
    } else {
      stripEl.classList.remove('on')
      group3D.visible = true
      buildSpines3D(layout).children.forEach(c => group3D.add(c))
      const [x, y, z] = shelfPosition(agent)
      group3D.position.set(x, y, z)
    }
  }

  function show(agent) {
    if (!agent || !agent.gitPath) { hide(); return }
    const myReq = ++reqId
    current = { agent, layout: { empty: true, single: false, spines: [], count: 0, maxDays: 0 } }
    render()
    loadLog(agent.gitPath).then(data => {
      if (myReq !== reqId) return   // a later select() beat this fetch home
      const entries = (data && data.ok && Array.isArray(data.entries)) ? data.entries : []
      current = { agent, layout: layoutShelf(entries) }
      render()
    })
  }

  function hide() {
    reqId++
    current = null
    render()
  }

  function setMode(m) {
    mode = m === 'strip' ? 'strip' : '3d'
    render()
  }

  function onKeydown(e) {
    if (e.key !== 'h' && e.key !== 'H') return
    const tag = (document.activeElement && document.activeElement.tagName) || ''
    if (tag === 'INPUT' || tag === 'TEXTAREA') return
    setMode(mode === '3d' ? 'strip' : '3d')
  }
  addEventListener('keydown', onKeydown)

  let raf = 0
  function frame() {
    raf = requestAnimationFrame(frame)
    if (!current || mode !== 'strip' || !camera || !canvas) return
    const [x, y, z] = shelfPosition(current.agent)
    const [sx, sy] = projectToScreen(camera, canvas, [x, y + 0.10, z])
    stripEl.style.left = sx + 'px'
    stripEl.style.top = sy + 'px'
  }
  if (typeof requestAnimationFrame === 'function') frame()

  return {
    show,
    hide,
    setMode,
    get mode() { return mode },
    dispose() {
      if (raf) cancelAnimationFrame(raf)
      removeEventListener('keydown', onKeydown)
      clearGroup3D()
      if (scene) scene.remove(group3D)
      stripEl.remove()
      style.remove()
    },
  }
}
