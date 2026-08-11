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
  box-shadow:0 6px 24px #4a1f3d18;display:none;z-index:5}
#ip.on{display:block}
#ip h2{font-size:15px;margin:0 0 2px;letter-spacing:-.01em;color:#35455C}
#ip .role{font-size:12px;color:#A5738C;margin:0 0 9px}
#ip dl{margin:0;display:grid;grid-template-columns:58px 1fr;gap:2px 8px;font-size:12px}
#ip dt{color:#8A94A3}
#ip dd{margin:0;color:#35455C;overflow-wrap:anywhere}
#ip .hint{margin:10px 0 0;font-size:11px;color:#8A94A3;border-top:1px solid #E9E0CE;padding-top:8px}
#it{position:fixed;pointer-events:none;background:#35455Cee;color:#F0ECE6;font-size:11px;
  padding:3px 7px;border-radius:5px;display:none;transform:translate(13px,15px);
  white-space:nowrap;z-index:6}
`

export function attachInteraction(cfg) {
  const { canvas, camera, scene, world, floor, rug,
          props = {}, desks = [], log = () => {} } = cfg

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

  function matsOf(pick) {
    if (!pick) return null
    if (pick.kind === 'agent') return pick.ref.mats
    return pick.mats || null
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
   */
  const _c = new THREE.Color()
  function tint(mats, hex) {
    if (!mats) return
    for (const m of mats) {
      const base = m.userData.base != null ? m.userData.base : 0xffffff
      if (hex == null) { m.color.setHex(base); continue }
      m.color.setHex(base).lerp(_c.setHex(hex), 0.6)
    }
  }
  function setHover(pick) {
    if (pick === hovered) return
    if (hovered && !(selected && hovered.kind === 'agent' && hovered.ref === selected))
      tint(matsOf(hovered), null)
    hovered = pick
    if (pick && !(selected && pick.kind === 'agent' && pick.ref === selected))
      tint(matsOf(pick), HOVER_TINT)
    const show = pick && pick.kind !== 'floor'
    tip.style.display = show ? 'block' : 'none'
    if (show) tip.textContent = pick.label
    canvas.style.cursor = pick ? 'pointer' : ''
  }
  function select(agent) {
    if (selected) tint(selected.mats, null)
    selected = agent || null
    if (selected) tint(selected.mats, P.mustard)
    ring.visible = !!selected
    panel.classList.toggle('on', !!selected)
    paint()
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

  canvas.addEventListener('pointerdown', e => {
    down = true; dx0 = e.clientX; dy0 = e.clientY; t0 = performance.now(); moved = 0
  })
  addEventListener('pointerup', e => {
    if (down && moved < 6 && performance.now() - t0 < 600) click(e.clientX, e.clientY)
    down = false
  })
  addEventListener('pointermove', e => {
    if (down) { moved = Math.max(moved, Math.hypot(e.clientX-dx0, e.clientY-dy0)); return }
    tip.style.left = e.clientX + 'px'; tip.style.top = e.clientY + 'px'
    const now = performance.now()
    if (now - hoverAt < 45) return          // the camera moves; 22 Hz is plenty
    hoverAt = now
    const h = pickAt(e.clientX, e.clientY)
    setHover(h ? h.pick : null)
  })

  const api = {
    pickAt, click, select, paint, pickable, desks,
    get selected() { return selected },
    hoverAt(x, y) { const h = pickAt(x, y); setHover(h ? h.pick : null); return h ? h.pick.label : null },
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
