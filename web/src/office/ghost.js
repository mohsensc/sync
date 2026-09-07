// Ghost authors: "who wrote the code this agent is touching," rendered as
// a person instead of a stat. Polls /api/git/blame for whatever region an
// agent holds (see blamecard.js's own region reading — same .gitPath/
// .gitStart/.gitEnd fields), takes the majority author of that region
// (owners[0] — gitapi.mjs's blame route already sorts by lines and dedupes
// by email, so this IS the majority author, no extra math needed here),
// and shows it as one of three things:
//
//   ghost  (default) — a translucent (~0.3 opacity), hair-tinted clone of
//     the character rig standing beside the editing agent's desk, plus a
//     small nameplate. Fades in/out, idle sway — see the file header on
//     why this doesn't get its own animation system.
//   plate  — the nameplate only, no figure.
//   off    — the whole feature, encounters included.
//
// Cycled by the G key and ?ghost= (default 'ghost').
//
// ENCOUNTERS. If the majority author is the human behind another agent
// currently in the room, the passive treatment is skipped entirely and a
// real clip fires between the two of them instead: blame newer than
// ENCOUNTER_ARGUE_DAYS -> argue ("I just wrote that"), older -> handshake.
// Argue reuses World.contest() (agent.js already folds clips/argue.js's
// clips into ANIM.CLIPS at import time, so this is the exact same call
// pairUp()/world.highfive() make in office.html). Handshake has no World-
// level helper to call, so this drives it the same way World.highfive()
// does internally: walk both agents onto clips/handshake.js's own marks
// via Agent.goTo (the controller owns the pathing — see that file's
// header), then fire clips/handshake.js's exported playHandshake() on
// each root directly once they've arrived. No IK, no new animation
// system, no new World method.
//
// office.html can't export makeCharacterRoot (it's a local function, not
// a module) or skinnedClone (three/addons import), so both get passed in
// here rather than duplicated — same for live.js's hairFor. The wiring is
// in office.html's setupCast(), next to attachGitSignals: poll() runs once
// on attach, and anywhere earlier than that it would run against an empty
// world.agents and a rig that hasn't loaded.

import * as THREE from 'three'
import * as ANIM from './anim.js'
import { yawToward } from './agent.js'
import {
  handshakeMarks, spacingFor as handshakeSpacingFor,
  playHandshake, getClip as getHandshakeClip,
} from './clips/handshake.js'
import { makeAmbientThrottle } from './frame-throttle.js'

// ---------------------------------------------------------------------
// Pure decision logic. No DOM, no THREE, no fetch — fixture-tested
// directly in web/test/ghost.test.ts, same pattern zoneowner.js's
// pickOwnership/flourishFor use.
// ---------------------------------------------------------------------

/** Blame newer than this reads as "someone's still annoyed about it" —
 *  argue. Older is water under the bridge — handshake. About a week, same
 *  ballpark gitsignals.js's own freshness ring uses for "hot". */
export const ENCOUNTER_ARGUE_DAYS = 7

/**
 * decideGhostTreatment(blame, roster, opts) -> what to render for one
 * agent's held region.
 *
 *   blame  — /api/git/blame's response body: {ok, owners:[{author,lines,
 *     share}], newestLineAgeDays} or {ok:false, ...}. owners[0] is the
 *     majority author (already sorted, already deduped by email).
 *   roster — every agent currently in the room: [{id, human, busy}].
 *   opts.mode — 'ghost' | 'plate' | 'off'.
 *   opts.selfId — the editing agent's own id, excluded from the roster
 *     search (so a file only that agent has ever touched can't "encounter"
 *     itself).
 *
 * Returns exactly one of:
 *   {kind:'none'}
 *   {kind:'ghost'|'plate', author, ageDays}
 *   {kind:'encounter', author, ageDays, partnerId, clip:'argue'|'handshake'}
 */
export function decideGhostTreatment(blame, roster, opts = {}) {
  const { mode = 'ghost', selfId = null, encounterAgeDays = ENCOUNTER_ARGUE_DAYS } = opts
  if (mode === 'off') return { kind: 'none' }
  if (!blame || blame.ok !== true || !Array.isArray(blame.owners) || blame.owners.length === 0) {
    return { kind: 'none' } // untracked path, empty file, fetch failure — never an empty ghost
  }
  const top = blame.owners[0]
  const author = top && top.author
  if (!author) return { kind: 'none' }
  const ageDays = typeof blame.newestLineAgeDays === 'number' ? blame.newestLineAgeDays : null

  const partner = Array.isArray(roster)
    ? roster.find(r => r && r.id !== selfId && !r.busy && r.human && r.human === author)
    : null
  if (partner) {
    const clip = (ageDays != null && ageDays <= encounterAgeDays) ? 'argue' : 'handshake'
    return { kind: 'encounter', author, ageDays, partnerId: partner.id, clip }
  }
  return { kind: mode, author, ageDays }
}

// ---------------------------------------------------------------------
// Copy + nameplate texture
// ---------------------------------------------------------------------

function ageLabel(ageDays) {
  if (ageDays == null) return 'a while back'
  if (ageDays <= 0) return 'today'
  if (ageDays === 1) return '1d ago'
  if (ageDays < 30) return `${ageDays}d ago`
  const months = Math.round(ageDays / 30)
  return months <= 1 ? '1mo ago' : `${months}mo ago`
}

/** Exported so the harness/tests can check the exact copy without
 *  re-deriving it from a canvas. */
export function plateText(author, ageDays) {
  return `wrote most of this · ${ageLabel(ageDays)} · ${author}`
}

function roundRect(g, x, y, w, h, r) {
  g.beginPath()
  g.moveTo(x + r, y)
  g.arcTo(x + w, y, x + w, y + h, r)
  g.arcTo(x + w, y + h, x, y + h, r)
  g.arcTo(x, y + h, x, y, r)
  g.arcTo(x, y, x + w, y, r)
  g.closePath()
}

function plateTexture(author, ageDays, tint) {
  const W = 380, H = 100
  const c = document.createElement('canvas')
  c.width = W; c.height = H
  const g = c.getContext('2d')
  roundRect(g, 3, 3, W - 6, H - 6, 16)
  g.fillStyle = '#fffdfaf2'; g.fill()
  g.lineWidth = 3; g.strokeStyle = tint; g.stroke()
  g.textAlign = 'left'
  g.font = '600 25px ui-sans-serif, -apple-system, Segoe UI, sans-serif'
  g.fillStyle = '#35455C'
  g.fillText('wrote most of this', 20, 40)
  g.font = '400 19px ui-sans-serif, -apple-system, Segoe UI, sans-serif'
  g.fillStyle = '#6b5f56'
  g.fillText(`${ageLabel(ageDays)} · ${author}`, 20, 72)
  const t = new THREE.CanvasTexture(c)
  t.anisotropy = 8
  return t
}

function buildPlateSprite(author, ageDays, tint) {
  const sp = new THREE.Sprite(new THREE.SpriteMaterial({
    map: plateTexture(author, ageDays, tint), transparent: true, depthTest: false, opacity: 0,
  }))
  sp.scale.set(0.95, 0.25, 1)
  sp.renderOrder = 12
  return sp
}

// ---------------------------------------------------------------------
// Placement — a fixed offset beside wherever the editing agent currently
// stands. Recomputed once per poll, not per frame: a ghost is meant to
// read as "parked at the desk", not as a shadow that chases its agent
// around the room.
// ---------------------------------------------------------------------
function deskOffset(agent) {
  return { x: agent.pos.x + 0.6, z: agent.pos.z + 0.05 }
}

// ---------------------------------------------------------------------
// attachGhostAuthors()
// ---------------------------------------------------------------------

function initialMode() {
  try {
    const m = new URLSearchParams(location.search).get('ghost')
    return m === 'plate' || m === 'off' ? m : 'ghost'
  } catch {
    return 'ghost' // no `location` outside a browser
  }
}

const FADE_S = 1.0            // fade in/out duration
const GHOST_BODY_OPACITY = 0.3
const PLATE_OPACITY = 0.95
const ENCOUNTER_COOLDOWN_MS = 45_000
const ARGUE_ENCOUNTER_MS = 5_200   // how long a ghost-triggered argue runs before resolving itself

/**
 * attachGhostAuthors({ world, scene, skinnedClone, makeCharacterRoot,
 *   hairFor, getGltf, fetchFn, intervalMs }) ->
 *   { setMode(m), mode, poll(), tick(dt), dispose() }
 *
 * Self-contained on the poll side: runs its own blame poll loop, same
 * shape as zoneowner.js's attachZoneOwner and gitsignals.js's
 * attachGitSignals — three independent, all-cheap git pollers is already
 * documented as acceptable at this repo's size (see STATE.md's "known
 * duplication" note); this is a fourth of the same shape, not a new kind
 * of debt. The fade/sway used to run its own rAF loop for the same
 * "no shared seam" reason; office.html now runs one frame loop for the
 * whole page, so tick(dt) rides that instead of starting its own.
 */
export function attachGhostAuthors(cfg = {}) {
  const {
    world = null,
    scene = null,
    skinnedClone = null,
    makeCharacterRoot = null,
    hairFor = () => '#8A94A3',
    getGltf = () => null,
    fetchFn = (...a) => fetch(...a),
    intervalMs = 18_000,
    now = () => Date.now(),
  } = cfg

  const root = new THREE.Group()
  root.name = 'ghost-authors-root'
  if (scene) scene.add(root)

  let mode = initialMode()
  const states = new Map()          // agentId -> state (see buildGhostState/buildPlateState)
  const lastEncounterAt = new Map() // agentId -> ms
  const blameCache = new Map()      // key -> { at, promise }
  const CACHE_TTL_MS = Math.max(5_000, intervalMs - 2_000)

  // -- data ---------------------------------------------------------------

  function fetchBlame(path, start, end) {
    const hasRange = Number.isFinite(start) && Number.isFinite(end)
    const key = hasRange ? `${path}#${start}-${end}` : path
    const cached = blameCache.get(key)
    const t = now()
    if (cached && t - cached.at < CACHE_TTL_MS) return cached.promise
    const qs = hasRange ? `&start=${start}&end=${end}` : ''
    const p = fetchFn(`/api/git/blame?path=${encodeURIComponent(path)}${qs}`)
      .then(r => r.json()).catch(() => ({ ok: false, reason: 'fetch failed' }))
    blameCache.set(key, { at: t, promise: p })
    return p
  }

  // -- encounters -----------------------------------------------------------

  /** Fires one real clip between self and partner. Returns true if it
   *  actually started something (both free, marks computed), false if it
   *  declined (busy) — caller treats false as "try again next poll". */
  function fireEncounter(self, partner, clip) {
    if (!world || self.busy || partner.busy) return false
    if (clip === 'argue') {
      const e = world.contest(self, partner)
      if (!e) return false
      setTimeout(() => world.resolveContest(e), ARGUE_ENCOUNTER_MS)
      return true
    }
    // handshake — no World-level helper; drive it the same shape
    // World.highfive() uses internally: Agent.goTo() onto clips/
    // handshake.js's own marks, then its own playHandshake() once both
    // have arrived. See the file header for why.
    const height = (self.height + partner.height) / 2
    const marks = handshakeMarks(
      new THREE.Vector3(self.pos.x, 0, self.pos.z),
      new THREE.Vector3(partner.pos.x, 0, partner.pos.z),
      handshakeSpacingFor(height))
    self.busy = true; partner.busy = true
    const release = () => {
      self.busy = false; partner.busy = false
      ANIM.crossfade(self.root, 'idle', 0.3)
      ANIM.crossfade(partner.root, 'idle', 0.3)
    }
    Promise.all([
      self.goTo(marks.a.pos.x, marks.a.pos.z, {
        yaw: yawToward(marks.a.pos.x, marks.a.pos.z, marks.b.pos.x, marks.b.pos.z),
        label: 'greeting ' + partner.name,
      }),
      partner.goTo(marks.b.pos.x, marks.b.pos.z, {
        yaw: yawToward(marks.b.pos.x, marks.b.pos.z, marks.a.pos.x, marks.a.pos.z),
        label: 'greeting ' + self.name,
      }),
    ]).then(() => {
      // Same frame, both of them, same clip — the sync story every paired
      // action in this app tells; see handshake.js's own header.
      playHandshake(self.root)
      playHandshake(partner.root)
      setTimeout(release, getHandshakeClip().duration * 1000 + 250)
    }).catch(release)
    return true
  }

  // -- visuals --------------------------------------------------------------

  function buildGhostState(agent, decision) {
    const gltf = getGltf()
    if (!gltf || !skinnedClone || !makeCharacterRoot) return null // rig not ready — try again next poll
    const color = hairFor(decision.author)
    const figRoot = makeCharacterRoot(skinnedClone(gltf.scene), 1.68, color)
    const mats = []
    figRoot.traverse(n => {
      if (!n.isMesh && !n.isSkinnedMesh) return
      // The shadow map's depth pass ignores material opacity, so a ghost —
      // built invisible and faded in toward GHOST_BODY_OPACITY — would throw
      // a fully solid shadow before it's visible at all. makeCharacterRoot
      // turns castShadow on for every real character; undo it here.
      n.castShadow = false
      const list = Array.isArray(n.material) ? n.material : [n.material]
      for (const m of list) { m.transparent = true; m.depthWrite = false; m.opacity = 0; mats.push(m) }
    })
    ANIM.crossfade(figRoot, 'idle', 0)
    // A mixer never applies a pose until update() actually runs — .play()
    // alone leaves the skeleton in its bind pose. A ghost is meant to be
    // parked, not animated (see the file header), so this is the only
    // update() call it ever gets: one frame at dt=0 just evaluates and
    // applies the clip's frame 0, then tick() below never touches the
    // mixer again.
    ANIM.update(figRoot, 0)
    root.add(figRoot)
    const plate = buildPlateSprite(decision.author, decision.ageDays, color)
    root.add(plate)
    const state = {
      kind: 'ghost', id: agent.id, author: decision.author, ageDays: decision.ageDays,
      figRoot, mats, plate, presence: 0, removing: false, swayPhase: Math.random() * Math.PI * 2,
    }
    positionState(state, agent)
    return state
  }

  function buildPlateState(agent, decision) {
    const color = hairFor(decision.author)
    const plate = buildPlateSprite(decision.author, decision.ageDays, color)
    root.add(plate)
    const state = {
      kind: 'plate', id: agent.id, author: decision.author, ageDays: decision.ageDays,
      figRoot: null, mats: [], plate, presence: 0, removing: false, swayPhase: 0,
    }
    positionState(state, agent)
    return state
  }

  function positionState(state, agent) {
    const { x, z } = deskOffset(agent)
    if (state.figRoot) {
      state.figRoot.position.set(x, 0, z)
      state.figRoot.rotation.y = agent.root.rotation.y
      state.plate.position.set(x, 1.98, z)
    } else {
      state.plate.position.set(x, 1.72, z)
    }
  }

  function refreshPlateText(state, decision) {
    state.ageDays = decision.ageDays
    const tint = hairFor(decision.author)
    const old = state.plate.material.map
    state.plate.material.map = plateTexture(decision.author, decision.ageDays, tint)
    state.plate.material.needsUpdate = true
    if (old) old.dispose()
  }

  function disposeState(state) {
    if (state.figRoot) {
      root.remove(state.figRoot)
      ANIM.dispose(state.figRoot)
      for (const m of state.mats) m.dispose()
    }
    if (state.plate) {
      root.remove(state.plate)
      if (state.plate.material.map) state.plate.material.map.dispose()
      state.plate.material.dispose()
    }
  }

  function beginRemove(id) {
    const s = states.get(id)
    if (s) s.removing = true
  }

  function upsertVisual(agent, decision) {
    const existing = states.get(agent.id)
    if (existing && existing.kind === decision.kind && existing.author === decision.author) {
      existing.removing = false
      positionState(existing, agent)
      if (decision.kind === 'plate' && existing.ageDays !== decision.ageDays) refreshPlateText(existing, decision)
      else existing.ageDays = decision.ageDays
      return
    }
    if (existing) { disposeState(existing); states.delete(agent.id) }
    const built = decision.kind === 'ghost' ? buildGhostState(agent, decision) : buildPlateState(agent, decision)
    if (built) states.set(agent.id, built)
  }

  // -- poll -------------------------------------------------------------

  // Renamed from the generic `tick` to `poll` so it doesn't collide with
  // the per-frame tick(dt) below — this one hits the network on a timer,
  // that one runs off office.html's frame loop.
  async function poll() {
    if (!world) return
    if (mode === 'off') { for (const id of [...states.keys()]) beginRemove(id); return }

    const roster = world.agents.map(a => ({ id: a.id, human: a.role || null, busy: !!a.busy }))
    let encounterFiredThisTick = false

    for (const a of world.agents) {
      if (!a.gitPath) { if (states.has(a.id)) beginRemove(a.id); continue }
      if (a.busy) continue // already doing something real — leave whatever it had alone

      const hasRegion = Number.isFinite(a.gitStart) && Number.isFinite(a.gitEnd) && a.gitEnd > a.gitStart
      const blame = await fetchBlame(a.gitPath, hasRegion ? a.gitStart : undefined, hasRegion ? a.gitEnd : undefined)
      const decision = decideGhostTreatment(blame, roster, { mode, selfId: a.id })

      if (decision.kind === 'encounter') {
        // At most one new ghost-encounter per poll — real information beats
        // a room full of simultaneous arguments, and it's what keeps most
        // of the cast showing plain ghosts (see demo.js's note on why only
        // one cast member's human is ever set to a real name).
        if (encounterFiredThisTick) continue
        const last = lastEncounterAt.get(a.id) || 0
        if (now() - last < ENCOUNTER_COOLDOWN_MS) continue
        const partner = world.byId(decision.partnerId)
        if (!partner) continue
        if (fireEncounter(a, partner, decision.clip)) {
          encounterFiredThisTick = true
          lastEncounterAt.set(a.id, now())
          beginRemove(a.id)
        }
        continue
      }

      if (decision.kind === 'ghost' || decision.kind === 'plate') upsertVisual(a, decision)
      else beginRemove(a.id)
    }
  }

  // Per-agent counterpart to dispose(): office.html's despawnLive calls
  // this for one agent instead of waiting for the whole room to tear
  // down. poll() only ever visits ids still in world.agents, so a
  // despawned agent's state/lastEncounterAt entries would otherwise sit
  // here forever with tick() still writing sway transforms to them every
  // ambient frame — same bug gitsignals.js's forget() fixed for desk-fx.
  // Disposes immediately rather than routing through beginRemove's fade:
  // the agent it was parked beside is already gone, so there's nothing
  // left to fade next to.
  function forget(agent) {
    const s = states.get(agent.id)
    if (s) disposeState(s)
    states.delete(agent.id)
    lastEncounterAt.delete(agent.id)
  }

  // -- per-frame: fade + idle sway -----------------------------------------
  // A ghost's fade and sway are slow, ambient motion — not something
  // that needs a full 60Hz step (see frame-throttle.js). No mixer update
  // here: a ghost takes its idle pose once, in buildGhostState above, and
  // holds it — the sway below is a root-transform write, which is nearly
  // free, standing in for what would otherwise be a per-ghost skeleton
  // update every frame for a figure that's meant to read as parked.

  const ambient = makeAmbientThrottle()
  function tick(dt) {
    const elapsed = ambient(dt)
    if (!elapsed) return
    for (const [id, s] of states) {
      const target = s.removing ? 0 : 1
      s.presence += (target - s.presence) * Math.min(1, elapsed / FADE_S)
      if (s.figRoot) {
        const bodyOp = s.presence * GHOST_BODY_OPACITY
        for (const m of s.mats) m.opacity = bodyOp
        s.swayPhase += elapsed * 0.7
        s.figRoot.position.y = Math.sin(s.swayPhase) * 0.012
        s.figRoot.rotation.z = Math.sin(s.swayPhase * 0.6) * 0.01
      }
      s.plate.material.opacity = s.presence * PLATE_OPACITY
      if (s.removing && s.presence < 0.01) { disposeState(s); states.delete(id) }
    }
  }

  // -- mode + key handling -------------------------------------------------

  function setMode(m) {
    mode = (m === 'plate' || m === 'off') ? m : 'ghost'
    poll()
  }

  function onKeydown(e) {
    if (e.key !== 'g' && e.key !== 'G') return
    const tag = (document.activeElement && document.activeElement.tagName) || ''
    if (tag === 'INPUT' || tag === 'TEXTAREA') return
    setMode(mode === 'ghost' ? 'plate' : mode === 'plate' ? 'off' : 'ghost')
  }
  if (typeof addEventListener === 'function') addEventListener('keydown', onKeydown)

  let timer = null
  if (world) { poll(); timer = setInterval(poll, intervalMs) }

  return {
    setMode,
    get mode() { return mode },
    poll,
    tick,
    forget,
    dispose() {
      if (timer) clearInterval(timer)
      if (typeof removeEventListener === 'function') removeEventListener('keydown', onKeydown)
      for (const s of states.values()) disposeState(s)
      states.clear()
      if (scene) scene.remove(root)
    },
  }
}
