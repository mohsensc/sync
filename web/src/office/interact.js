// Click and hover for the office.
//
// Lives apart from office.html so the scene file stays a scene file. Call
// attachInteraction() once the characters exist; it builds its own panel and
// tooltip, so there is nothing to add to the markup.
//
// PICKING. Every target gets an invisible proxy — a box for props and desks, a
// capsule for a character — and the raycaster only ever sees those. Raycasting
// the real meshes would mean 31k triangles per character per mouse move, and a
// SkinnedMesh reports a bind-pose bounding volume anyway, so the proxy is both
// faster and more accurate. Raycaster ignores `visible`, which is what makes
// this work.
//
// Zone rings and label sprites sit over the floor. They carry no pick owner, so
// the hit loop skips them and finds the floor underneath instead of swallowing
// the click.

import * as THREE from 'three'
import * as Z from './zones.js'

const P = { cream:0xF0ECE6, sand:0xE9E0CE, taupe:0xC3B39B, butter:0xF7DFAF,
            mustard:0xD6B45C, caramel:0xC0762A, terracotta:0xD9714F,
            mauve:0xA5738C, slate:0x8A94A3, navy:0x35455C, plum:0x4A1F3D }

// What a prop means when you send someone to it.
const PROP_JOB = {
  vault:    { zone:'vault',  act:'reading',  label:'the vault',      task:'checking credentials' },
  phones:   { zone:'phones', act:'waving',   label:'the phone wall', task:'calling an external API' },
  cables:   { zone:'cables', act:'reading',  label:'the cable ball', task:'reading the dependency graph' },
  tortoise: { zone:null,     act:'drinking', label:'the tortoise',   task:'waiting on a long job' },
}

const CSS = `
#ip{position:fixed;right:18px;top:74px;width:238px;background:#fffdfaee;
  border:1px solid #C3B39B;border-radius:10px;padding:12px 14px;
  box-shadow:0 6px 24px #4a1f3d18;z-index:5;
  opacity:0;transform:translateX(8px);pointer-events:none;
  transition:opacity .22s ease,transform .22s ease}
#ip.on{opacity:1;transform:none;pointer-events:auto}
#ip h2{font-size:15px;margin:0 0 2px;letter-spacing:-.01em;color:#35455C}
#ip .role{font-size:12px;color:#A5738C;margin:0 0 9px}
#ip dl{margin:0;display:grid;grid-template-columns:58px 1fr;gap:2px 8px;font-size:12px}
#ip dt{color:#8A94A3}
#ip dd{margin:0;color:#35455C;overflow-wrap:anywhere}
#ip .hint{margin:10px 0 0;font-size:11px;color:#8A94A3;border-top:1px solid #E9E0CE;padding-top:8px}
#it{position:fixed;pointer-events:none;display:none;transform:translate(13px,15px);z-index:6}
#it.on{display:block}
#it.tag{background:#35455Cee;color:#F0ECE6;font-size:11px;padding:3px 7px;
  border-radius:5px;white-space:nowrap}
#it.card{width:206px;background:#fffdfaee;border:1px solid #C3B39B;border-radius:10px;
  padding:10px 12px;box-shadow:0 8px 26px #4a1f3d22;
  animation:itin .16s cubic-bezier(.16,1,.3,1)}
#it.card h3{margin:0 0 1px;font-size:13px;letter-spacing:-.01em;color:#35455C}
#it.card .sub{margin:0 0 8px;font-size:11px;color:#A5738C}
#it.card dl{margin:0;display:grid;grid-template-columns:38px 1fr;gap:1px 6px;font-size:10.5px}
#it.card dt{color:#8A94A3}
#it.card dd{margin:0;color:#35455C;overflow-wrap:anywhere}
#it.card .git{margin-top:7px;padding-top:7px;border-top:1px solid #E9E0CE;
  font-size:10.5px;color:#C0762A}
#it.card .git.stale{color:#8A94A3}
#it.card .git.own{border-top:none;margin-top:2px;padding-top:2px;color:#A5738C}
@keyframes itin{from{opacity:0;transform:translateY(-3px)}to{opacity:1;transform:translateY(0)}}
@media (prefers-reduced-motion: reduce){#it.card{animation:none}}

/* Second treatment (press H to cycle): a nameplate that floats in 3D space
   over the character's head instead of trailing the cursor in a corner
   card. Small on purpose — a whisper, same spirit as the hover tint. */
#it.nameplate{transform:translate(-50%,-100%);text-align:center}
#it.nameplate .np{display:inline-flex;flex-direction:column;align-items:center;
  gap:1px;background:#35455Cd9;color:#F0ECE6;padding:4px 10px 5px;
  border-radius:8px;box-shadow:0 4px 14px #4a1f3d2e;
  animation:npin .15s cubic-bezier(.16,1,.3,1)}
#it.nameplate .np-name{font-size:12px;font-weight:600;letter-spacing:-.01em;white-space:nowrap}
#it.nameplate .np-role{font-size:9.5px;color:#C3B39B;white-space:nowrap}
#it.nameplate::after{content:'';position:absolute;left:50%;bottom:-4px;
  transform:translateX(-50%);border:5px solid transparent;border-top-color:#35455Cd9}
@keyframes npin{from{opacity:0;transform:translateY(4px) scale(.9)}to{opacity:1;transform:none}}

/* Third treatment: the same rich card, but the ownership line moves up to
   sit right under the role, ahead of doing/zone/file — for when "whose
   code is this" is the thing you actually want to lead with. Cards are a
   flex column so DOM order (fixed by renderAgentCard/host.after) can be
   overridden purely with CSS \`order\` — no restructuring needed when the
   git rows land asynchronously after the fetch resolves. */
#it.card{display:flex;flex-direction:column}
#it.card h3{order:0}
#it.card .sub{order:1}
#it.card dl{order:3}
#it.card .git{order:4}
#it.card.rich .git.own{order:2;border-top:none;border-bottom:1px solid #E9E0CE;
  margin:0 0 8px;padding:0 0 8px;font-size:12px;font-weight:600;color:#4A1F3D}
`

const ESC_MAP = { '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }
const esc = s => String(s).replace(/[&<>"']/g, c => ESC_MAP[c])

function fmtAge(days) {
  if (days == null) return 'recently'
  if (days < 1) return 'today'
  if (days < 1.5) return '1d ago'
  return `${Math.round(days)}d ago`
}

/**
 * Whose code is this, for one agent against one blame result.
 *
 * `identity` is whatever we have for the agent as a human name — `role` on
 * live agents (the relay's `human` field), `name` as a last resort for the
 * demo cast, which has no human attached to it at all. Matches loosely
 * (case-insensitive substring either direction) because a demo identity like
 * "agent-3" was never going to equal a real git author string, and even a
 * real human's display name and git author name often differ by a nickname
 * or a middle name — see this repo's own two author strings for `mohsensc`.
 *
 * Degrades to the top owner, `matched:false`, rather than nothing — a desk
 * or hover line always has something honest to say, never an empty claim.
 * Pure and exported so it's testable without a fetch or a DOM.
 */
export function ownershipShare(blame, identity) {
  if (!blame || blame.ok === false || !blame.owners || blame.owners.length === 0) return null
  const id = String(identity || '').trim().toLowerCase()
  const hit = id && blame.owners.find(o => {
    const a = String(o.author || '').toLowerCase()
    return a === id || (a.length > 1 && id.includes(a)) || (id.length > 1 && a.includes(id))
  })
  const top = blame.owners[0]
  if (hit) return { pct: Math.round(hit.share * 100), matched: true, name: hit.author }
  return { pct: Math.round(top.share * 100), matched: false, name: top.author }
}

export function attachInteraction(cfg) {
  const { canvas, camera, scene, world, floor, rug,
          props = {}, desks = [], log = () => {}, onSelect,
          fetchFn = (typeof fetch !== 'undefined' ? fetch.bind(globalThis) : null) } = cfg

  // ---- DOM ---------------------------------------------------------------
  const style = document.createElement('style')
  style.textContent = CSS
  document.head.appendChild(style)

  const panel = document.createElement('div')
  panel.id = 'ip'
  panel.innerHTML = `<h2 id="ipName">—</h2><p class="role" id="ipRole">—</p>
    <dl><dt>doing</dt><dd id="ipDoing">—</dd>
        <dt>headed</dt><dd id="ipDest">—</dd>
        <dt>zone</dt><dd id="ipZone">—</dd>
        <dt>at</dt><dd id="ipPos">—</dd></dl>
    <p class="hint">Click the floor, a desk or a prop to send it there.</p>`
  document.body.appendChild(panel)
  const tip = document.createElement('div')
  tip.id = 'it'
  document.body.appendChild(tip)
  const $ = id => document.getElementById(id)

  // ---- git stat, cached ---------------------------------------------------
  // One fetch per hovered path, reused for ~30s. Hovering the same agent
  // twice inside that window costs nothing; a fresh git process is cheap but
  // there is no reason to spawn one every time the mouse crosses a capsule.
  const GIT_TTL = 30000
  const gitCache = new Map()
  async function statLine(path) {
    const now = Date.now()
    const hit = gitCache.get(path)
    if (hit && now - hit.t < GIT_TTL) return hit.v
    let v
    try {
      if (!fetchFn) throw new Error('no fetch')
      const r = await fetchFn(`/api/git/stat?path=${encodeURIComponent(path)}`)
      v = r.ok ? await r.json() : { ok:false }
    } catch { v = { ok:false } }
    gitCache.set(path, { t:now, v })
    return v
  }

  // ---- git blame, cached separately -----------------------------------
  // Ownership (desk tint + the hover card's "whose code" line) needs the
  // full blame breakdown, not the one-line stat summary above — different
  // endpoint, different shape, so it gets its own cache rather than being
  // squeezed into gitCache. STATE.md already flags that gitsignals.js runs
  // its own poller against a *different* endpoint (stat) with no shared
  // cache between the two files; this is a third, still-separate cache
  // against blame specifically. Not worth a shared module for one round.
  const BLAME_TTL = 60000
  const blameCache = new Map()
  async function fetchBlame(path) {
    const now = Date.now()
    const hit = blameCache.get(path)
    if (hit && now - hit.t < BLAME_TTL) return hit.v
    let v
    try {
      if (!fetchFn) throw new Error('no fetch')
      const r = await fetchFn(`/api/git/blame?path=${encodeURIComponent(path)}`)
      v = r.ok ? await r.json() : { ok:false }
    } catch { v = { ok:false } }
    blameCache.set(path, { t:now, v })
    return v
  }

  // ---- proxies -----------------------------------------------------------
  const pickable = []
  const hidden = new THREE.MeshBasicMaterial()

  function boxProxy(group, pick) {
    group.updateMatrixWorld(true)
    const b = new THREE.Box3().setFromObject(group)
    const s = b.getSize(new THREE.Vector3())
    const c = b.getCenter(new THREE.Vector3())
    const m = new THREE.Mesh(new THREE.BoxGeometry(
      Math.max(s.x, 0.05), Math.max(s.y, 0.05), Math.max(s.z, 0.05)), hidden)
    m.position.copy(c)
    m.visible = false
    m.userData.pick = pick
    scene.add(m)
    pickable.push(m)
    return m
  }

  function capsuleProxy(agent) {
    const m = new THREE.Mesh(new THREE.CylinderGeometry(0.36, 0.36, 1.78, 10), hidden)
    m.position.y = 0.89
    m.visible = false
    m.userData.pick = { kind:'agent', ref:agent, label:agent.name }
    agent.root.add(m)
    pickable.push(m)
    return m
  }

  /** Own materials, so highlighting one clone doesn't light up all eight.
   *  Base is the diffuse colour, which for a character is its per-agent tint. */
  function ownMaterials(o) {
    const mats = []
    o.traverse(n => {
      if (!n.isMesh || n.material === hidden || n.userData.decor) return
      n.material = n.material.clone()
      n.material.userData = { ...n.material.userData, base: n.material.color.getHex() }
      mats.push(n.material)
    })
    return mats
  }

  if (floor) { floor.userData.pick = { kind:'floor', label:'floor' }; pickable.push(floor) }
  if (rug)   { rug.userData.pick   = { kind:'floor', label:'floor' }; pickable.push(rug) }

  for (const d of desks) {
    d.mats = ownMaterials(d.group)
    boxProxy(d.group, { kind:'desk', ref:d, label:d.label, mats:d.mats })
  }
  for (const id in props) {
    const job = PROP_JOB[id]
    if (!job) continue
    const g = props[id]
    if (!g) continue
    job.id = id
    job.group = g
    job.mats = ownMaterials(g)
    job.stand = standFor(job, g)
    boxProxy(g, { kind:'prop', ref:job, label:job.label, mats:job.mats })
  }
  for (const a of world.agents) {
    a.mats = ownMaterials(a.root)
    capsuleProxy(a)
  }

  /** Where to stand for a prop: a zone slot if the zone system has one, else
   *  1.35 m out from the prop on the room-centre side. */
  function standFor(job, g) {
    if (job.zone && Z.ZONES[job.zone]) {
      const s = Z.ZONES[job.zone].slots[0]
      return { x:s[0], z:s[1], yaw:s[2] }
    }
    const p = new THREE.Vector3()
    g.getWorldPosition(p)
    const dx = 0.4 - p.x, dz = -0.5 - p.z
    const l = Math.hypot(dx, dz) || 1
    const [x, z] = Z.clampToFloor(p.x + dx / l * 1.35, p.z + dz / l * 1.35)
    return { x, z, yaw: Z.yawToward(x, z, p.x, p.z) }
  }

  // ---- highlight ---------------------------------------------------------
  const ring = new THREE.Mesh(new THREE.RingGeometry(0.44, 0.53, 44),
    new THREE.MeshBasicMaterial({ color:P.navy, transparent:true, opacity:0.9,
      depthWrite:false, side:THREE.DoubleSide }))
  ring.rotation.x = -Math.PI/2; ring.position.y = 0.08; ring.renderOrder = 4
  ring.visible = false; scene.add(ring)

  const goal = new THREE.Mesh(new THREE.RingGeometry(0.17, 0.26, 32),
    new THREE.MeshBasicMaterial({ color:P.caramel, transparent:true, opacity:0.95,
      depthWrite:false, side:THREE.DoubleSide }))
  goal.rotation.x = -Math.PI/2; goal.position.y = 0.07; goal.renderOrder = 4
  goal.visible = false; scene.add(goal)

  // Hover is a whisper, selection is a statement. Anything stronger on hover
  // and the whole room flickers as the cursor crosses it.
  const HOVER_TINT = 0xFCEFD2
  let selected = null, hovered = null
  // Focus mode: office.html sets this while a head-zoom flight is holding the
  // camera, so the zoomed state reads as "character + blame card" instead of
  // that plus a hover card and the corner selection panel repeating the same
  // facts. Suppresses new tooltip renders and hides the panel; doesn't touch
  // the 3D hover tint, which is subtle enough to keep.
  let focusMode = false

  function matsOf(pick) {
    if (!pick) return null
    if (pick.kind === 'agent') return pick.ref.mats
    // Real raycast picks carry `.mats` directly (see boxProxy/capsuleProxy).
    // The ownership scan below builds lightweight `{kind:'desk', ref}` picks
    // of its own to reuse applyRest() outside of a hover/click, so fall back
    // to the desk's own mats when the pick didn't carry them.
    return pick.mats || (pick.ref && pick.ref.mats) || null
  }
  /**
   * Highlight by blending the DIFFUSE colour toward the highlight hue.
   *
   * This used to drive the emissive instead, because the GLBs shipped with
   * metalness = 1 — which zeroes the diffuse term, so material.color did
   * nothing and emissive was the only knob that showed. office.html now
   * normalises those materials to a dielectric so the key light can model them,
   * which puts diffuse back in charge and makes emissive the dead knob instead.
   *
   * Blending rather than replacing matters: each character carries a per-agent
   * body tint as its base, and a hard overwrite would erase the one cue that
   * tells eight identical clay figures apart. Pass null to restore.
   *
   * `alpha` overrides the blend strength — the hover pulse below rides this
   * to breathe the tint in and out instead of snapping to a flat wash.
   */
  const _c = new THREE.Color()
  function tint(mats, hex, alpha = 0.6) {
    if (!mats) return
    for (const m of mats) {
      const base = m.userData.base != null ? m.userData.base : 0xffffff
      if (hex == null) { m.color.setHex(base); continue }
      m.color.setHex(base).lerp(_c.setHex(hex), alpha)
    }
  }

  // ---- whose desk is this -------------------------------------------
  // A desk's "resting" colour is no longer always the bare base — if the
  // agent seated there is mostly typing their own code it rests tinted in
  // their own colour, and if it's mostly someone else's it rests in a
  // shared neutral. `restState()` is what setHover() restores TO instead
  // of null, so hovering a tinted desk and moving on doesn't wipe the tint.
  const TEAMMATE_HUE = P.slate
  function restState(pick) {
    if (!pick || pick.kind !== 'desk') return null
    return pick.ref.ownership || null
  }
  function applyRest(pick) {
    if (!pick) return
    const r = restState(pick)
    if (r) tint(matsOf(pick), r.hex, r.alpha)
    else tint(matsOf(pick), null)
  }

  // Two treatments to compare, toggled with T: a steady low-alpha wash, or
  // a slow breathe between the agent's own hue and the neutral teammate hue
  // — same "breathe" idea as the hover pulse above, just much slower and
  // driven by ownership rather than mouse attention. `desk.ownership` (set
  // by scanDesks below) always carries BOTH ends of that gradient so this
  // loop never has to re-derive them.
  let deskTintMode = 'steady'
  let breathePhase = 0
  let pulseDeskT = performance.now()
  function pulseDesks(t) {
    const dt = Math.min(0.05, (t - pulseDeskT) / 1000)
    pulseDeskT = t
    if (deskTintMode === 'breathe') {
      breathePhase += dt * 0.6                 // ~10s round trip — a mood, not a blink
      const k = 0.5 + 0.5 * Math.sin(breathePhase)
      for (const d of desks) {
        if (!d.ownership) continue
        if (hovered && hovered.kind === 'desk' && hovered.ref === d) continue // hover pulse owns this one
        const hex = k > 0.5 ? d.ownership.hex : d.ownership.otherHex
        tint(d.mats, hex, 0.14 + 0.14 * Math.abs(k - 0.5) * 2)
      }
    }
    requestAnimationFrame(pulseDesks)
  }
  requestAnimationFrame(pulseDesks)

  /** Who's sitting at this desk right now, if anyone — same "seated and
   *  within reach of the seat mark" test office.html uses for its own
   *  chair-slide animation, just read here instead of owned here. */
  function seatedAt(d) {
    return world.agents.find(a => a.seated &&
      Math.hypot(a.pos.x - d.seat[0], a.pos.z - d.seat[1]) < 0.55)
  }

  const DESK_SCAN_MS = 3000
  async function scanDesks() {
    for (const d of desks) {
      const a = seatedAt(d)
      if (!a || !a.gitPath) {
        d.ownership = null
        if (!(hovered && hovered.kind === 'desk' && hovered.ref === d)) applyRest({ kind:'desk', ref:d })
        continue
      }
      const blame = await fetchBlame(a.gitPath)
      const share = ownershipShare(blame, a.role || a.name)
      d.ownership = share ? {
        hex: share.matched && share.pct >= 50 ? a.color : TEAMMATE_HUE,
        otherHex: share.matched && share.pct >= 50 ? TEAMMATE_HUE : a.color,
        alpha: 0.22,
        share,
      } : null
      if (!(hovered && hovered.kind === 'desk' && hovered.ref === d)) applyRest({ kind:'desk', ref:d })
    }
  }
  scanDesks()
  setInterval(scanDesks, DESK_SCAN_MS)

  // A flat hover tint reads as a UI state change; a pulsing one reads as
  // something alive noticing you. Runs its own rAF rather than piggybacking
  // office.html's render loop, since interact.js has no other hook into it.
  let pulseT = performance.now()
  let hoverPhase = 0
  function pulseHover(t) {
    const dt = Math.min(0.05, (t - pulseT) / 1000)
    pulseT = t
    if (hovered && !(selected && hovered.kind === 'agent' && hovered.ref === selected)) {
      hoverPhase += dt * 3.4
      tint(matsOf(hovered), HOVER_TINT, 0.4 + 0.22 * (0.5 + 0.5 * Math.sin(hoverPhase)))
    }
    // The nameplate lives in world space, not cursor space — it has to
    // track the camera every frame (zoom flight, orbit drag) rather than
    // only on pointermove like the corner card does.
    if (hovered && hovered.kind === 'agent' && hoverTreatment === 'nameplate') {
      const [x, y] = projectHead(hovered.ref)
      tip.style.left = x + 'px'; tip.style.top = y + 'px'
    }
    requestAnimationFrame(pulseHover)
  }
  requestAnimationFrame(pulseHover)

  let hoverToken = 0
  function renderTag(pick) {
    tip.className = 'tag on'
    tip.textContent = pick.label
  }

  // Three hover treatments for one agent, cycled with H. `card` is the
  // original: doing/zone/file plus two git rows appended below once their
  // fetches resolve. `nameplate` is the opposite instinct — nothing but a
  // name and role, floating over the head in world space instead of
  // trailing the cursor, for when the corner card is more chrome than the
  // room needs. `rich` is `card` again but the ownership line (whose code
  // this is) gets promoted above doing/zone/file via CSS `order` — see the
  // #it.card.rich rule above — because on a contested file that line is
  // usually the one thing worth reading first.
  const HOVER_TREATMENTS = ['card', 'nameplate', 'rich']
  let hoverTreatment = 'card'

  /** Screen position of a point roughly at head height for `a`, for the
   *  nameplate treatment. Same projection math as the api's project(),
   *  just fixed to head height rather than floor level. */
  function projectHead(a) {
    const v = new THREE.Vector3(a.pos.x, 1.55, a.pos.z).project(camera)
    const r = canvas.getBoundingClientRect()
    return [r.left + (v.x * 0.5 + 0.5) * r.width, r.top + (-v.y * 0.5 + 0.5) * r.height]
  }

  function renderNameplate(a) {
    tip.className = 'nameplate on'
    const role = a.note || a.role || 'agent'
    tip.innerHTML = `<span class="np"><span class="np-name">${esc(a.name)}</span>` +
      `<span class="np-role">${esc(role)}</span></span>`
    const [x, y] = projectHead(a)
    tip.style.left = x + 'px'; tip.style.top = y + 'px'
  }

  function renderAgentCard(a, token) {
    tip.className = hoverTreatment === 'rich' ? 'card rich on' : 'card on'
    const role = a.note || a.role || 'agent'
    const zone = Z.zoneAt(a.pos.x, a.pos.z) || 'open floor'
    tip.innerHTML = `<h3>${esc(a.name)}</h3><p class="sub">${esc(role)}</p>
      <dl><dt>doing</dt><dd>${esc(a.doing)}</dd>
          <dt>zone</dt><dd>${esc(zone)}</dd>
          <dt>file</dt><dd>${a.gitPath ? esc(a.gitPath) : '—'}</dd></dl>`
    if (!a.gitPath) return
    statLine(a.gitPath).then(v => {
      if (token !== hoverToken) return                 // hover moved on since
      const host = tip.querySelector('dl')
      if (!host || !v || v.ok === false) return         // omit the row, not an empty box
      const fresh = v.lastAgeDays != null && v.lastAgeDays < 2
      const stale = v.lastAgeDays != null && v.lastAgeDays > 180
      const row = document.createElement('div')
      row.className = 'git' + (fresh ? ' fresh' : stale ? ' stale' : '')
      const authors = v.authorCount === 1 ? '1 author' : `${v.authorCount} authors`
      row.textContent = `last touched ${fmtAge(v.lastAgeDays)} by ${v.lastAuthor} · ${v.commits} commits · ${authors}`
      host.after(row)
    })
    fetchBlame(a.gitPath).then(v => {
      if (token !== hoverToken) return
      const host = tip.querySelector('dl')
      const share = ownershipShare(v, a.role || a.name)
      if (!host || !share) return              // no blame at all — omit, don't claim
      const row = document.createElement('div')
      row.className = 'git own'
      row.textContent = share.matched
        ? `code is ${share.pct}% theirs`
        : `mostly ${share.name}'s code`
      host.after(row)
    })
  }
  function renderHoveredAgent(a, token) {
    if (hoverTreatment === 'nameplate') renderNameplate(a)
    else renderAgentCard(a, token)
  }
  function setHover(pick) {
    if (pick === hovered) return
    if (hovered && !(selected && hovered.kind === 'agent' && hovered.ref === selected))
      applyRest(hovered)
    hovered = pick
    hoverPhase = 0
    hoverToken++
    canvas.style.cursor = pick ? 'pointer' : ''
    const show = pick && pick.kind !== 'floor' && !focusMode
    tip.classList.toggle('on', !!show)
    if (!show) return
    if (pick.kind === 'agent') renderHoveredAgent(pick.ref, hoverToken)
    else renderTag(pick)
  }
  // H cycles the three hover treatments above. Kept separate from T (desk
  // tint) since they're independent questions — "how does ownership read on
  // a desk" vs. "how does a hovered agent's card read" — and the owner asked
  // for both to be pickable on their own.
  addEventListener('keydown', e => {
    if (e.key !== 'h' && e.key !== 'H') return
    if (e.target && /input|textarea/i.test(e.target.tagName)) return
    hoverTreatment = HOVER_TREATMENTS[(HOVER_TREATMENTS.indexOf(hoverTreatment) + 1) % HOVER_TREATMENTS.length]
    log(`hover card: ${hoverTreatment}`)
    if (hovered && hovered.kind === 'agent') renderHoveredAgent(hovered.ref, hoverToken)
  })
  function select(agent) {
    if (selected) tint(selected.mats, null)
    selected = agent || null
    if (selected) tint(selected.mats, P.mustard)
    ring.visible = !!selected
    panel.classList.toggle('on', !!selected && !focusMode)
    // Whatever hover card is on screen was set by the last pointermove, and
    // a selection can happen without one — a click that landed dead still,
    // a keyboard/console select, zoomToAgent()'s onSelect hook. Left alone
    // it sits there describing the wrong agent until the mouse next moves.
    // Clearing it here, on every select() including deselect, means it's
    // never stale for longer than the frame it takes onSelect to fire.
    setHover(null)
    paint()
    onSelect?.(selected)
    return selected
  }
  function paint() {
    if (!selected) { goal.visible = false; return }
    $('ipName').textContent = selected.name
    $('ipRole').textContent = selected.note || selected.role || '—'
    $('ipDoing').textContent = selected.doing
    $('ipDest').textContent = selected.destination || 'nowhere'
    $('ipZone').textContent = Z.zoneAt(selected.pos.x, selected.pos.z) || 'open floor'
    $('ipPos').textContent = `${selected.pos.x.toFixed(1)}, ${selected.pos.z.toFixed(1)}`
    ring.position.set(selected.pos.x, 0.08, selected.pos.z)
    const m = selected._move
    goal.visible = !!m
    if (m) goal.position.set(m.x, 0.07, m.z)
  }

  // ---- commands ----------------------------------------------------------
  function sendToFloor(a, x, z) {
    const [cx, cz] = Z.clampToFloor(x, z)
    a.say('')
    a.goTo(cx, cz, { label:`floor ${cx.toFixed(1)}, ${cz.toFixed(1)}` })
    log(`${a.name} → floor ${cx.toFixed(1)}, ${cz.toFixed(1)}`)
  }
  function sendToDesk(a, d) {
    a.say('')
    a.destination = d.label
    a.sitAt(d.seat[0], d.seat[1], d.seat[2])
    log(`${a.name} → ${d.label}, sit and type`)
  }
  function sendToProp(a, job) {
    a.say(job.task, 'working')
    a.goTo(job.stand.x, job.stand.z, {
      yaw: job.stand.yaw, label: job.label,
      then: ag => ag.act(job.act),
    })
    log(`${a.name} → ${job.label}, ${job.task}`)
  }

  // ---- raycast -----------------------------------------------------------
  const ray = new THREE.Raycaster()
  const ndc = new THREE.Vector2()

  function pickAt(cx, cy) {
    const r = canvas.getBoundingClientRect()
    ndc.x = ((cx - r.left) / r.width) * 2 - 1
    ndc.y = -((cy - r.top) / r.height) * 2 + 1
    ray.setFromCamera(ndc, camera)
    const hits = ray.intersectObjects(pickable, false)
    for (const h of hits) {
      let o = h.object
      while (o && !o.userData.pick) o = o.parent
      if (o) return { pick:o.userData.pick, point:h.point }
    }
    return null
  }

  function click(cx, cy) {
    const hit = pickAt(cx, cy)
    if (!hit) { select(null); return null }
    const { pick, point } = hit
    if (pick.kind === 'agent') { select(pick.ref); log(`selected ${pick.ref.name}`); return pick }
    if (!selected) { log('select a figure first'); return pick }
    if (selected.busy) { log(`${selected.name} is mid high five`); return pick }
    if (pick.kind === 'floor') sendToFloor(selected, point.x, point.z)
    else if (pick.kind === 'desk') sendToDesk(selected, pick.ref)
    else if (pick.kind === 'prop') sendToProp(selected, pick.ref)
    return pick
  }

  // ---- pointer -----------------------------------------------------------
  // The orbit handlers in office.html own the drag. We only need to tell a
  // click from a drag, so track how far the pointer travelled while down.
  let down = false, dx0 = 0, dy0 = 0, t0 = 0, moved = 0, hoverAt = 0

  // T swaps the two desk-ownership treatments, steady wash vs. slow breathe,
  // so they can be sat side by side rather than argued about from memory.
  addEventListener('keydown', e => {
    if (e.key !== 't' && e.key !== 'T') return
    if (e.target && /input|textarea/i.test(e.target.tagName)) return
    deskTintMode = deskTintMode === 'steady' ? 'breathe' : 'steady'
    log(`desk ownership tint: ${deskTintMode}`)
    if (deskTintMode === 'steady') for (const d of desks) applyRest({ kind:'desk', ref:d })
  })

  canvas.addEventListener('pointerdown', e => {
    down = true; dx0 = e.clientX; dy0 = e.clientY; t0 = performance.now(); moved = 0
  })
  addEventListener('pointerup', e => {
    if (down && moved < 6 && performance.now() - t0 < 600) click(e.clientX, e.clientY)
    down = false
  })
  addEventListener('pointermove', e => {
    if (down) { moved = Math.max(moved, Math.hypot(e.clientX-dx0, e.clientY-dy0)); return }
    // Nameplate positions itself off the head every frame (see pulseHover);
    // mouse-following here would fight that and jitter.
    if (hoverTreatment !== 'nameplate') { tip.style.left = e.clientX + 'px'; tip.style.top = e.clientY + 'px' }
    const now = performance.now()
    if (now - hoverAt < 45) return          // the camera moves; 22 Hz is plenty
    hoverAt = now
    const h = pickAt(e.clientX, e.clientY)
    setHover(h ? h.pick : null)
  })

  const api = {
    pickAt, click, select, paint, pickable, desks,
    get selected() { return selected },
    /** Force an ownership rescan now instead of waiting for the 3s poll —
     *  for scripted browser verification. */
    scanDesks,
    get deskTintMode() { return deskTintMode },
    setDeskTintMode(mode) {
      deskTintMode = mode === 'breathe' ? 'breathe' : 'steady'
      if (deskTintMode === 'steady') for (const d of desks) applyRest({ kind:'desk', ref:d })
    },
    get hoverTreatment() { return hoverTreatment },
    setHoverTreatment(mode) {
      if (!HOVER_TREATMENTS.includes(mode)) return
      hoverTreatment = mode
      if (hovered && hovered.kind === 'agent') renderHoveredAgent(hovered.ref, hoverToken)
    },
    hoverAt(x, y) { const h = pickAt(x, y); setHover(h ? h.pick : null); return h ? h.pick.label : null },
    /** office.html's focus mode: while true, no new hover card shows and the
     *  corner selection panel stays hidden even with something selected. */
    get focusMode() { return focusMode },
    setFocusMode(v) {
      focusMode = !!v
      if (focusMode) tip.classList.remove('on')
      panel.classList.toggle('on', !!selected && !focusMode)
    },
    /** Force whatever hover card is showing to clear right now — used at
     *  the start of a head-zoom flight, belt-and-braces alongside select()'s
     *  own clear (see there) for any future call path that reaches
     *  zoomToAgent without going through select() first. */
    clearHover() { setHover(null) },
    /** Register a click target for an agent added after attachInteraction()
     *  ran — every live-spawned character, since the roster at setup time is
     *  only ever the demo cast. */
    addAgent(a) {
      a.mats = ownMaterials(a.root)
      capsuleProxy(a)
    },
    /** Undo addAgent()/the initial roster registration for an agent that is
     *  about to be despawned. Clears selection/hover if it was pointing here. */
    removeAgent(a) {
      for (let i = pickable.length - 1; i >= 0; i--) {
        const pick = pickable[i].userData.pick
        if (pick && pick.kind === 'agent' && pick.ref === a) {
          pickable[i].geometry.dispose()
          pickable.splice(i, 1)
        }
      }
      if (selected === a) select(null)
      if (hovered && hovered.kind === 'agent' && hovered.ref === a) setHover(null)
    },
    /** Screen position of a floor point, for scripted clicks. */
    project(x, z) {
      const v = new THREE.Vector3(x, 0.05, z).project(camera)
      const r = canvas.getBoundingClientRect()
      return [ r.left + (v.x*0.5+0.5)*r.width, r.top + (-v.y*0.5+0.5)*r.height ]
    },
    props: PROP_JOB,
  }
  return api
}
