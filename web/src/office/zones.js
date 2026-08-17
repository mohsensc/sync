// Zones: named floor regions in the office, each standing for a kind of agent work.
//
// The office is a cutaway room, 20 x 15, open on +x and +z. Walls on -z (back)
// and -x (left). Every zone below is anchored to a prop that already exists in
// office.html's PLAN, or to a patch of free floor if its prop was never made.
// Zones with no prop get a floor disc and a label and nothing else — that is
// honest, and it still reads.
//
// Coordinates are [x, z] on the floor plane. Yaw here is the EXTERNAL yaw
// convention that agent.js consumes: forward is -(sin y, 0, cos y), so
// yawToward() negates both components. The rig itself faces +Z; agent.js adds
// YAW_OFFSET on the way to rotation.y. Do not mix the two — everything in this
// file, and anything compared against it, is external yaw.

import * as THREE from 'three'

export const PALETTE = {
  cream: 0xF0ECE6, sand: 0xE9E0CE, taupe: 0xC3B39B, sage: 0xE5E1D2,
  butter: 0xF7DFAF, mustard: 0xD6B45C, caramel: 0xC0762A, coffee: 0xB0674F,
  terracotta: 0xD9714F, salmon: 0xE8946C, rose: 0xD8BDB6, mauve: 0xA5738C,
  slate: 0x8A94A3, navy: 0x35455C, plum: 0x4A1F3D,
}

/** Walkable floor, inset from the walls so nobody clips a corner.
 *  Room is 18 x 13.6, so the shell is x [-9, 9], z [-6.8, 6.8]. */
export const BOUNDS = { minX: -8.3, maxX: 8.4, minZ: -6.0, maxZ: 6.3 }

export function clampToFloor(x, z) {
  return [
    Math.max(BOUNDS.minX, Math.min(BOUNDS.maxX, x)),
    Math.max(BOUNDS.minZ, Math.min(BOUNDS.maxZ, z)),
  ]
}

// ---------------------------------------------------------------------------
// The zones
// ---------------------------------------------------------------------------
// prop      — the PLAN entry this zone sits against, or null if there is none
// at        — zone centre, used for the floor marker and for zoneAt()
// r         — radius, metres
// slots     — [x, z, yaw] standing spots. Agents claim these one at a time.
// means     — the product meaning, shown in the legend
// ---------------------------------------------------------------------------
// Layout note: these were pulled in from a 20 x 15 room to an 18 x 13.6 one.
// The old spread left a lot of dead floor between the desk cluster and the
// walls, which read as an empty room rather than a busy one. Zone radii came
// down with the positions so the rings still bound roughly what they used to.
export const ZONES = {
  reception: {
    label: 'reception',
    means: 'incoming work',
    prop: 'reception desk',
    // r covers the outermost slot. At 1.55 the two flanking marks sat 1.556 out
    // and zoneAt() called them open floor, so the panel said "open floor" for
    // someone standing squarely at reception.
    at: [-6.9, 0.8], r: 1.7, color: PALETTE.taupe,
    slots: [[-5.8, 0.8, Math.PI / 2], [-5.8, 1.9, Math.PI / 2], [-5.8, -0.3, Math.PI / 2]],
  },
  vault: {
    label: 'vault',
    means: 'auth and secrets',
    prop: 'vault-door.glb',
    at: [-6.0, -4.9], r: 1.6, color: PALETTE.plum,
    slots: [[-6.0, -4.8, Math.PI], [-7.0, -4.5, Math.PI], [-5.0, -4.5, Math.PI]],
  },
  phones: {
    label: 'phone wall',
    means: 'external API calls',
    prop: 'phone-wall.glb',
    at: [5.4, -4.9], r: 1.6, color: PALETTE.mauve,
    slots: [[5.4, -4.9, Math.PI], [4.4, -4.6, Math.PI], [6.4, -4.6, Math.PI]],
  },
  desks: {
    label: 'desks',
    means: 'ordinary edits',
    prop: 'desk-tripo-12k.glb x6',
    at: [0.4, -0.5], r: 4.0, color: PALETTE.butter,
    // Two rows facing each other across the aisle. Seats are on the aisle side
    // of each desk. Column spacing came down from 3.6 to 3.0 — at 3.6 the desks
    // read as six islands rather than one bank.
    //
    // The z values are deliberately UNCHANGED. Pulling the rows together as
    // well left no room between a standing agent's mark and the desk edge for
    // a chair to exist in, and the figures ended up standing inside the
    // backrests. The aisle is the one dimension here that was already right.
    slots: [
      [-2.6, -1.35, 0], [0.4, -1.35, 0], [3.4, -1.35, 0],
      [-2.6, 0.35, Math.PI], [0.4, 0.35, Math.PI], [3.4, 0.35, Math.PI],
    ],
  },
  cables: {
    label: 'cable ball',
    means: 'the dependency graph',
    prop: 'cable-ball.glb',
    // Same as reception: r has to reach the third slot at 1.581.
    at: [-7.0, 4.5], r: 1.65, color: PALETTE.coffee,
    slots: [[-5.9, 4.3, -Math.PI / 2], [-6.1, 5.4, -Math.PI / 2], [-6.1, 3.2, -Math.PI / 2]],
  },
  crates: {
    label: 'crates',
    means: 'build artifacts and CI',
    prop: null,
    at: [7.3, -1.7], r: 1.45, color: PALETTE.caramel,
    slots: [[6.3, -1.7, -Math.PI / 2], [6.5, -2.7, -Math.PI / 2], [6.5, -0.7, -Math.PI / 2]],
  },
  fire: {
    label: 'fire',
    means: 'failing tests',
    prop: null,
    at: [7.4, 3.1], r: 1.3, color: PALETTE.terracotta,
    slots: [[6.4, 3.1, -Math.PI / 2], [6.8, 4.0, -Math.PI / 2], [6.8, 2.2, -Math.PI / 2]],
  },
  ducks: {
    label: 'ducks',
    means: 'reasoning',
    prop: null,
    at: [-1.8, 4.8], r: 1.4, color: PALETTE.mustard,
    slots: [[-1.8, 3.9, Math.PI], [-2.9, 4.2, Math.PI], [-0.7, 4.2, Math.PI]],
  },
  whiteboard: {
    label: 'whiteboard',
    means: 'planning',
    prop: null,
    // Pulled off the wall: at z = -6.3 with r = 1.7 the ring cut straight
    // through the back wall and half the disc was invisible. The inner face of
    // that wall is at -6.625, so at + r has to stay clear of it.
    at: [-1.4, -5.3], r: 1.3, color: PALETTE.slate,
    slots: [[-1.4, -4.7, Math.PI], [-2.5, -4.7, Math.PI], [-0.3, -4.7, Math.PI]],
  },
  hammock: {
    label: 'hammock',
    means: 'idle',
    prop: null,
    at: [5.2, 5.0], r: 1.4, color: PALETTE.sage,
    slots: [[5.2, 5.0, -Math.PI / 2], [4.3, 5.5, -Math.PI / 2], [6.1, 5.5, -Math.PI / 2]],
  },
}

export const ZONE_NAMES = Object.keys(ZONES)

/** "conveyor area" in the product copy is the crate stack. Same place. */
export const ALIASES = { conveyor: 'crates', build: 'crates', secrets: 'vault', api: 'phones' }

export function zone(name) {
  const n = ALIASES[name] || name
  const z = ZONES[n]
  if (!z) throw new Error(`zones: no zone "${name}". Have: ${ZONE_NAMES.join(', ')}`)
  return z
}

// ---------------------------------------------------------------------------
// Routing: (verb, path) -> zone name
// ---------------------------------------------------------------------------
// Order matters. Verbs that are about thinking rather than touching a file win
// first, because "think" about package.json is still thinking. Then path shape,
// then the verb, then desks as the fallback. Most work is ordinary work.

const RE = {
  secret: /(^|[\/._-])(auth|authn|authz|secret|secrets|token|tokens|credential|credentials|password|passwd|apikey|api[_-]?key|jwt|oauth|session|keychain|vault)([\/._-]|$)|\.env(\.|$)|\.pem$|\.key$|id_rsa/i,
  ci: /(^|\/)\.github\/workflows\/|(^|\/)\.gitlab-ci\.ya?ml$|(^|\/)Jenkinsfile$|(^|\/)\.circleci\/|(^|\/)azure-pipelines\.ya?ml$|(^|\/)\.buildkite\/|(^|\/)(Dockerfile|docker-compose\.ya?ml)$|(^|\/)(Makefile|BUILD\.bazel|WORKSPACE)$|(^|\/)turbo\.json$/,
  manifest: /(^|\/)(package\.json|package-lock\.json|yarn\.lock|pnpm-lock\.ya?ml|bun\.lockb?|Cargo\.(toml|lock)|go\.(mod|sum)|requirements(-\w+)?\.txt|Pipfile(\.lock)?|poetry\.lock|pyproject\.toml|Gemfile(\.lock)?|pom\.xml|build\.gradle(\.kts)?|composer\.(json|lock)|\.tool-versions)$/,
  test: /(^|\/)(tests?|__tests__|spec|specs|e2e|fixtures)\/|\.(test|spec)\.[jt]sx?$|_test\.(go|py|rb)$|(^|\/)test_[^\/]+\.py$|Test\.java$/,
  url: /^(https?:)?\/\/|^www\.|\.(com|io|dev|net|org|ai)\//i,
}

/** Verbs that describe where the agent *is*, not what file it holds. */
const VERB_ZONE = {
  think: 'ducks', reason: 'ducks', analyze: 'ducks', analyse: 'ducks',
  plan: 'whiteboard', design: 'whiteboard', spec: 'whiteboard',
  idle: 'hammock', sleep: 'hammock', park: 'hammock', wait: 'hammock',
  start: 'reception', spawn: 'reception', queue: 'reception', accept: 'reception',
  fetch: 'phones', call: 'phones', request: 'phones', post: 'phones', curl: 'phones',
  build: 'crates', compile: 'crates', bundle: 'crates', deploy: 'crates', publish: 'crates',
  fail: 'fire', error: 'fire', crash: 'fire', regress: 'fire',
  auth: 'vault', login: 'vault', rotate: 'vault',
}

/**
 * Where should an agent stand, given what it is doing?
 * @param {string} verb  read | edit | write | test | think | plan | fetch | build | idle | ...
 * @param {string} [path] repo-relative file path, or a URL for external calls
 * @returns {string} zone name
 */
export function zoneFor(verb, path) {
  const v = String(verb || '').toLowerCase().trim()
  const p = String(path || '').trim()

  // 1. Thinking, planning, idling. No file involved even if one is named.
  if (v === 'think' || v === 'reason' || v === 'analyze' || v === 'analyse') return 'ducks'
  if (v === 'plan' || v === 'design' || v === 'spec') return 'whiteboard'
  if (v === 'idle' || v === 'sleep' || v === 'park' || v === 'wait') return 'hammock'

  // 2. A failing test burns, wherever its file lives.
  if (v === 'fail' || v === 'error' || v === 'crash' || v === 'regress') return 'fire'

  // 3. Path shape. Secrets outrank everything: auth/package.json is still auth.
  if (p) {
    if (RE.url.test(p)) return 'phones'
    if (RE.secret.test(p)) return 'vault'
    if (RE.ci.test(p)) return 'crates'          // the conveyor area
    if (RE.manifest.test(p)) return 'cables'
    if (RE.test.test(p)) return 'crates'
  }

  // 4. Verb, for everything the path did not settle.
  if (VERB_ZONE[v]) return VERB_ZONE[v]
  if (v === 'test' || v === 'lint' || v === 'typecheck') return 'crates'

  // 5. Ordinary work.
  return 'desks'
}

/** Which zone contains this point, or null. Nearest wins on overlap. */
export function zoneAt(x, z) {
  let best = null, bestD = Infinity
  for (const name of ZONE_NAMES) {
    const zn = ZONES[name]
    const d = Math.hypot(x - zn.at[0], z - zn.at[1])
    if (d <= zn.r && d < bestD) { best = name; bestD = d }
  }
  return best
}

// --- slot booking ----------------------------------------------------------
// Two agents on the same file co-locate, so slots are shared by default. The
// occupancy map is only used to spread agents out when they are doing
// unrelated work in the same zone.
const occupancy = new Map()   // "zone:index" -> agent id

export function claimSlot(zoneName, agentId, { share = null } = {}) {
  const zn = zone(zoneName)
  const key = i => `${zoneName}:${i}`

  // Co-location: if the agent we're sharing with already holds a slot here,
  // stand beside them rather than taking a fresh one.
  if (share != null) {
    for (let i = 0; i < zn.slots.length; i++) {
      if (occupancy.get(key(i)) === share) {
        const s = zn.slots[i]
        return { pos: [s[0] + 0.62, s[1]], yaw: s[2], index: i, shared: true }
      }
    }
  }
  for (let i = 0; i < zn.slots.length; i++) {
    if (!occupancy.has(key(i))) {
      occupancy.set(key(i), agentId)
      const s = zn.slots[i]
      return { pos: [s[0], s[1]], yaw: s[2], index: i, shared: false }
    }
  }
  // Full: ring the zone centre.
  const a = (agentId.length * 1.7) % (Math.PI * 2)
  return { pos: [zn.at[0] + Math.cos(a) * zn.r, zn.at[1] + Math.sin(a) * zn.r], yaw: a + Math.PI, index: -1, shared: false }
}

export function releaseSlots(agentId) {
  for (const [k, v] of occupancy) if (v === agentId) occupancy.delete(k)
}

export function resetSlots() { occupancy.clear() }

/** Yaw that makes a character at (fx,fz) face (tx,tz), external convention.
 *  Same function agent.js exports; kept here so zones.js stands alone. */
export function yawToward(fx, fz, tx, tz) {
  return Math.atan2(-(tx - fx), -(tz - fz))
}

// ---------------------------------------------------------------------------
// Visuals: a floor disc and a label per zone
// ---------------------------------------------------------------------------
// A flat label on a cream floor is unreadable, so each one is a solid pill
// with the zone colour as a left rule. Drawn at 2x and scaled down, which is
// what keeps the type crisp at this sprite size.
function labelTexture(text, sub, hex) {
  const W = 512, H = 176, PAD = 18
  const c = document.createElement('canvas')
  c.width = W; c.height = H
  const g = c.getContext('2d')
  const col = '#' + hex.toString(16).padStart(6, '0')

  g.font = '700 52px ui-sans-serif, -apple-system, Segoe UI, sans-serif'
  const w1 = g.measureText(text).width
  g.font = '400 34px ui-sans-serif, -apple-system, Segoe UI, sans-serif'
  const w2 = g.measureText(sub).width
  const bw = Math.min(W - 8, Math.max(w1, w2) + PAD * 2 + 22)
  const bx = (W - bw) / 2, by = 14, bh = H - 28, r = 22

  g.beginPath()
  g.moveTo(bx + r, by); g.lineTo(bx + bw - r, by)
  g.quadraticCurveTo(bx + bw, by, bx + bw, by + r); g.lineTo(bx + bw, by + bh - r)
  g.quadraticCurveTo(bx + bw, by + bh, bx + bw - r, by + bh); g.lineTo(bx + r, by + bh)
  g.quadraticCurveTo(bx, by + bh, bx, by + bh - r); g.lineTo(bx, by + r)
  g.quadraticCurveTo(bx, by, bx + r, by)
  g.closePath()
  g.fillStyle = 'rgba(255,253,250,0.95)'; g.fill()
  g.lineWidth = 3; g.strokeStyle = 'rgba(53,69,92,0.22)'; g.stroke()

  // colour rule down the left edge, so the pill still says which zone it is
  g.save(); g.clip()
  g.fillStyle = col
  g.fillRect(bx, by, 10, bh)
  g.restore()

  g.textAlign = 'center'; g.textBaseline = 'middle'
  g.fillStyle = '#35455C'
  g.font = '700 52px ui-sans-serif, -apple-system, Segoe UI, sans-serif'
  g.fillText(text, W / 2 + 5, 66)
  g.fillStyle = '#6b5f56'
  g.font = '400 34px ui-sans-serif, -apple-system, Segoe UI, sans-serif'
  g.fillText(sub, W / 2 + 5, 118)

  const t = new THREE.CanvasTexture(c)
  t.anisotropy = 8
  return t
}

/**
 * Build the floor markers. Returns a Group you can add to the scene, plus a
 * setVisible(bool) and a highlight(name) for the demo.
 */
export function buildZoneMarkers({ labels = true, y = 0.045 } = {}) {
  const group = new THREE.Group()
  group.name = 'zoneMarkers'
  const rings = {}, sprites = {}

  for (const name of ZONE_NAMES) {
    const zn = ZONES[name]
    const mat = new THREE.MeshBasicMaterial({
      color: zn.color, transparent: true, opacity: 0.42,
      depthWrite: false, side: THREE.DoubleSide,
    })
    const ring = new THREE.Mesh(new THREE.RingGeometry(zn.r * 0.88, zn.r, 56), mat)
    ring.rotation.x = -Math.PI / 2
    ring.position.set(zn.at[0], y, zn.at[1])
    ring.renderOrder = 2
    group.add(ring)
    rings[name] = ring

    const fillMat = new THREE.MeshBasicMaterial({
      color: zn.color, transparent: true, opacity: 0.14,
      depthWrite: false, side: THREE.DoubleSide,
    })
    const disc = new THREE.Mesh(new THREE.CircleGeometry(zn.r * 0.86, 48), fillMat)
    disc.rotation.x = -Math.PI / 2
    disc.position.set(zn.at[0], y - 0.004, zn.at[1])
    disc.renderOrder = 1
    group.add(disc)

    if (labels) {
      const sp = new THREE.Sprite(new THREE.SpriteMaterial({
        map: labelTexture(zn.label, zn.means, zn.color),
        transparent: true, depthTest: false, opacity: 0.95,
      }))
      // Low enough to read as attached to its patch of floor. At 2.35 they
      // floated free of the zone and the eye paired them with the wrong one.
      sp.scale.set(1.95, 0.67, 1)
      sp.position.set(zn.at[0], 1.15, zn.at[1])
      sp.renderOrder = 10
      group.add(sp)
      sprites[name] = sp
    }
  }

  const owners = {} // zone name -> last-set owner label, so re-renders don't need it re-passed

  // ---- camera-distance fade for the label pills ------------------------
  // These are sized to read from the normal wide room shot. The head-zoom
  // camera flight (office.html's Z/zoomToAgent) can park a couple of metres
  // from a desk zone's pill, and a sprite sized for the room shot fills most
  // of the frame from there and bleeds through the blame card sitting on top
  // of it — the exact bug zoneowner.js's plaques hit and fixed in 09b6ca3.
  // Same fade shape here: hidden below FADE_NEAR, full above FADE_FAR.
  //
  // `highlight()` above still owns each sprite's BASE opacity (1 when lit,
  // 0.2 when dimmed for a spotlighted neighbour, 0.95 as the resting
  // default) — updateCamera() multiplies that by the distance factor rather
  // than overwriting it, so a demo beat's spotlight and a close camera don't
  // fight each other for the same number.
  const FADE_NEAR = 3.0
  const FADE_FAR = 5.5
  let highlighted = undefined  // undefined: never called; null: cleared; name: one zone lit
  let forceHidden = false
  function baseOpacity(n) {
    if (highlighted === undefined) return 0.95
    if (highlighted === null) return 1
    return n === highlighted ? 1 : 0.2
  }

  group.userData.rings = rings
  group.userData.sprites = sprites
  return {
    group,
    setVisible(v) { group.visible = v },
    /** Pulse one zone and dim the rest. Pass null to clear. */
    highlight(name) {
      highlighted = name
      for (const n of ZONE_NAMES) {
        const on = name == null || n === name
        rings[n].material.opacity = on ? (name ? 0.75 : 0.42) : 0.12
        if (sprites[n]) sprites[n].material.opacity = on ? 1 : 0.2
      }
    },
    /** Focus mode: hide every label pill outright, regardless of camera
     *  distance — office.html flips this on for the duration of a head-zoom
     *  dwell so the zoomed state is the character and the blame card, not a
     *  faded-but-still-there pill hovering behind them. Distinct from
     *  setVisible(), which is the room's own "Zones" button. */
    setFocusHidden(v) {
      forceHidden = !!v
      if (forceHidden) for (const n of ZONE_NAMES) if (sprites[n]) sprites[n].material.opacity = 0
    },
    /** Call every frame with the live camera. No-op while forceHidden — the
     *  pills stay at 0 until focus mode releases them. */
    updateCamera(camera) {
      if (!camera || forceHidden) return
      for (const n of ZONE_NAMES) {
        const sp = sprites[n]
        if (!sp) continue
        // sp.position is already in world space: `group` never gets its own
        // transform set, so local and world coincide here.
        const d = camera.position.distanceTo(sp.position)
        const t = Math.min(1, Math.max(0, (d - FADE_NEAR) / (FADE_FAR - FADE_NEAR)))
        sp.material.opacity = baseOpacity(n) * t
      }
    },
    /** Shortlog-driven area ownership: repaint a zone's pill with "mostly
     *  <name>" under its usual meaning line. Pass null/undefined to clear
     *  back to plain `means`. No-op on an unknown zone or a labels:false
     *  build (no sprites to repaint). */
    setOwner(name, ownerLabel) {
      const zn = ZONES[name]
      const sp = sprites[name]
      if (!zn || !sp) return
      owners[name] = ownerLabel || null
      const sub = owners[name] ? `${zn.means} · mostly ${owners[name]}` : zn.means
      const old = sp.material.map
      sp.material.map = labelTexture(zn.label, sub, zn.color)
      sp.material.needsUpdate = true
      if (old) old.dispose()
    },
  }
}
