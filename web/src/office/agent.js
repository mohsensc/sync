// Character controller for the office.
//
// One Agent per clay figure: an activity state machine, a steering controller,
// and the mapping from "what the agent is doing" to a clip in anim.js.
// A World owns the agents and brokers the paired actions.
//
// It exports createAgent() with the shape the old agent-shim.js defined, so
// demo.js and zones.js keep working unchanged.
//
// ---------------------------------------------------------------------------
// FACING. Read this before touching a yaw.
// ---------------------------------------------------------------------------
// The rig faces +Z. Measured, not assumed: headfront sits 0.150 m at +Z from
// Head, and LeftToeBase sits 0.061 m at +Z from LeftFoot. anim.js says the same
// thing in its header. So an object with rotation.y = h points along
// (sin h, 0, cos h).
//
// zones.js assumes the mesh faces -Z and negates both components in
// yawToward(). Under that convention every character walks backwards. Rather
// than rewrite zones.js out from under the demo, this file treats the external
// yaw as THAT convention and adds PI on the way to rotation.y. Agent.yaw stays
// in the external convention, so anything comparing it to Z.yawToward() still
// lines up.
//
// ---------------------------------------------------------------------------
// FEET. The walk clip advances the body by metersPerCycle at timeScale 1, so
// the only speed that keeps the feet planted is
//     speed = timeScale * metersPerCycle / clipDuration
// We drive it backwards: pick a speed, solve for timeScale, every frame. That
// holds through acceleration and deceleration, which a fixed timeScale does
// not. The clip still has a residual slide inside stance (see anim.js) — this
// only guarantees the average is right.
// ---------------------------------------------------------------------------

import * as THREE from 'three'
import * as ANIM from './anim.js'
import { highfiveMarks, spacingFor } from './highfive.js'
import { argueMarks, spacingFor as argueSpacingFor, registry as ARGUE_CLIPS } from './clips/argue.js'
import { handshakeMarks, spacingFor as handshakeSpacingFor, registry as HANDSHAKE_CLIPS } from './clips/handshake.js'
import { shoveMarks, spacingFor as shoveSpacingFor, registry as SHOVE_CLIPS } from './clips/shove.js'
import { yieldMarks, spacingFor as yieldSpacingFor, registry as YIELD_CLIPS } from './clips/yield.js'
import { doubletakeMarks, spacingFor as doubletakeSpacingFor, registry as DOUBLETAKE_CLIPS } from './clips/doubletake.js'

// Fold the paired-action clips into anim.js's own table, once, at import
// time — before any agent has crossfaded into anything and cached the clip
// list. See anim.js's CLIPS export and each clip module's own header.
Object.assign(ANIM.CLIPS, ARGUE_CLIPS)
Object.assign(ANIM.CLIPS, HANDSHAKE_CLIPS)
Object.assign(ANIM.CLIPS, SHOVE_CLIPS)
Object.assign(ANIM.CLIPS, YIELD_CLIPS)
Object.assign(ANIM.CLIPS, DOUBLETAKE_CLIPS)

export const YAW_OFFSET = Math.PI

const clamp = (v, a, b) => v < a ? a : v > b ? b : v
const wrapPi = a => Math.atan2(Math.sin(a), Math.cos(a))

export const TUNING = {
  maxSpeed: 1.15,      // m/s
  accel: 2.8,
  decel: 2.2,
  turnWalk: 2.6,       // rad/s while moving
  turnIdle: 2.4,       // rad/s standing still
  minTurnFactor: 0.35, // fraction of maxSpeed kept while turning hard
  arrive: 0.07,        // m
  pivotDist: 1.0,      // inside this, a big turn is done on the spot
  pivotAngle: 1.0,
  pivotExit: 0.35,
  greetRange: 2.6,     // two arrivals this close will high five
  greetCooldown: 8.0,  // s
}

// Each activity owns its clip, its blend time and where it goes when it ends.
// oneShot activities are timed off the clip length.
const ACTS = {
  idle:       { clip: 'idle',     fade: 0.35 },
  walking:    { clip: 'walk',     fade: 0.28 },
  sitting:    { clip: 'sit',      fade: 0.30, oneShot: true, next: 'typing' },
  standing:   { clip: 'sit',      fade: 0.30, oneShot: true, next: 'idle', reverse: true },
  typing:     { clip: 'type',     fade: 0.45, seated: true },
  sleeping:   { clip: 'sleep',    fade: 0.60, seated: true },
  reading:    { clip: 'read',     fade: 0.45 },
  drinking:   { clip: 'drink',    fade: 0.45 },
  waving:     { clip: 'wave',     fade: 0.30 },
  highfiving: { clip: 'highfive', fade: 0.20, oneShot: true, next: 'idle' },
  // The contested-write pair. Not a one-shot: it loops until World.resolveContest()
  // ends it, because unlike a high five a real collision has no fixed length —
  // it lasts until the region is free. clips/argue.js supplies 'argue' and
  // 'argueReact' once World.contest() folds them into ANIM.CLIPS.
  arguing:    { clip: 'argue',      fade: 0.25 },
  reacting:   { clip: 'argueReact', fade: 0.25 },
  // Resolution beats — the reel plays these once a rung-3 collision clears.
  // Rung 3, decision "wait": the requester agreed to hold off. clips/handshake.js.
  handshaking: { clip: 'handshake', fade: 0.20, oneShot: true, next: 'idle' },
  // Rung 3, decision "abort": wait-die or a straight priority-tier win.
  // clips/shove.js — `shoving` is the winner, `shoveReacting` the loser.
  shoving:        { clip: 'shove',      fade: 0.18, oneShot: true, next: 'idle' },
  shoveReacting:  { clip: 'shoveReact', fade: 0.18, oneShot: true, next: 'idle' },
  // Rung 1: the reader notices the editor is already in there and steps
  // back. clips/yield.js — `yielding` is the reader, `keeping` the editor.
  yielding: { clip: 'yieldStep', fade: 0.18, oneShot: true, next: 'idle' },
  keeping:  { clip: 'yieldKeep', fade: 0.18, oneShot: true, next: 'idle' },
  // Rung 4: redundant work caught by similarity — same beat both sides,
  // mirrored. clips/doubletake.js.
  doubletaking: { clip: 'doubletake', fade: 0.16, oneShot: true, next: 'idle' },
}
export const ACTIVITIES = Object.keys(ACTS)

// Reverse lookup for play(), which is the low-level escape hatch: it swaps the
// clip without arming any transition. Keeping the label honest matters because
// the selection panel reads it.
const ACT_OF_CLIP = {
  idle: 'idle', walk: 'walking', sit: 'sitting', type: 'typing',
  read: 'reading', sleep: 'sleeping', drink: 'drinking', wave: 'waving',
  highfive: 'highfiving', argue: 'arguing', argueReact: 'reacting',
  handshake: 'handshaking', shove: 'shoving', shoveReact: 'shoveReacting',
  yieldStep: 'yielding', yieldKeep: 'keeping', doubletake: 'doubletaking',
}

const DOING = {
  idle: 'standing by', walking: 'walking', sitting: 'sitting down',
  standing: 'getting up', typing: 'typing', sleeping: 'asleep at the desk',
  reading: 'reading', drinking: 'on a break', waving: 'waving',
  highfiving: 'high fiving', arguing: 'arguing over it', reacting: 'not having it',
  handshaking: 'shaking on it', shoving: 'pulling rank', shoveReacting: 'shoved aside',
  yielding: 'stepping back', keeping: 'keeping at it', doubletaking: 'wait, you too?',
}

const TONE = {
  ok: '#35455C', working: '#C0762A', blocked: '#D9714F',
  idle: '#8A94A3', done: '#4A1F3D',
}

function badgeTexture(text, tone) {
  const c = document.createElement('canvas')
  c.width = 512; c.height = 128
  const g = c.getContext('2d')
  g.clearRect(0, 0, 512, 128)
  if (!text) return new THREE.CanvasTexture(c)
  g.font = '500 40px ui-monospace, SFMono-Regular, Menlo, monospace'
  const w = Math.min(492, g.measureText(text).width + 44)
  const x = (512 - w) / 2
  const r = 26
  g.beginPath()
  g.moveTo(x + r, 26); g.lineTo(x + w - r, 26)
  g.quadraticCurveTo(x + w, 26, x + w, 52); g.lineTo(x + w, 76)
  g.quadraticCurveTo(x + w, 102, x + w - r, 102); g.lineTo(x + r, 102)
  g.quadraticCurveTo(x, 102, x, 76); g.lineTo(x, 52)
  g.quadraticCurveTo(x, 26, x + r, 26)
  g.closePath()
  g.fillStyle = 'rgba(255,253,250,0.96)'; g.fill()
  g.lineWidth = 4; g.strokeStyle = TONE[tone] || TONE.ok; g.stroke()
  g.fillStyle = TONE[tone] || TONE.ok
  g.textAlign = 'center'; g.textBaseline = 'middle'
  g.fillText(text, 256, 65, w - 40)
  const t = new THREE.CanvasTexture(c)
  t.anisotropy = 4
  return t
}

let _seq = 0

export class Agent {
  constructor(opts = {}) {
    const {
      root, id = 'a' + (++_seq), name = id, role = '',
      pos = [0, 0], yaw = 0, color = 0x8A94A3, height = 1.68,
      scale = (root && root.userData && root.userData.scale) || 1,
      metersPerCycle = ANIM.WALK_CYCLE_METERS * scale,
    } = opts

    this.id = id
    this.name = name
    this.role = role
    this.root = root
    this.color = color
    this.scale = scale
    this.height = height                  // for highfive.js's marks/palm math

    this.pos = { x: pos[0], z: pos[1] }   // authoritative floor position
    this.yaw = yaw                        // external convention, see header

    this.state = 'ok'                     // ok | working | blocked (demo owns this)
    this.activity = 'idle'                // the state machine
    this.clip = 'idle'
    this.destination = null               // label for the panel
    this.busy = false                     // owned by an encounter
    this.world = null
    this.lastGreet = -99

    this.speed = 0
    this.metersPerCycle = metersPerCycle
    this.walkDur = ANIM.getClip('walk').duration
    this.natSpeed = metersPerCycle / this.walkDur    // ~0.87 m/s at timeScale 1

    this._move = null
    this._turn = null
    this._timer = null                    // { t, fn }, frame-locked so stop() kills it
    this._pivot = false
    this._pulse = 0

    // Badge over the head and a halo under the feet. The halo is how a blocked
    // agent stays readable from any camera angle.
    this.badge = new THREE.Sprite(new THREE.SpriteMaterial({
      map: badgeTexture('', 'ok'), transparent: true, depthTest: false, opacity: 0,
    }))
    this.badge.scale.set(2.4, 0.6, 1)
    this.badge.position.set(0, height + 0.52, 0)
    this.badge.renderOrder = 20

    this.halo = new THREE.Mesh(
      new THREE.RingGeometry(0.3, 0.42, 32),
      new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.55,
        depthWrite: false, side: THREE.DoubleSide }))
    this.halo.rotation.x = -Math.PI / 2
    this.halo.position.y = 0.06
    this.halo.renderOrder = 3
    // Decoration, not body. interact.js skips these when it takes ownership of
    // an agent's materials for highlighting.
    this.halo.userData.decor = true
    this.badge.userData.decor = true

    if (root) {
      root.add(this.badge)
      root.add(this.halo)
      root.position.set(this.pos.x, 0, this.pos.z)
      root.rotation.y = this.yaw + YAW_OFFSET
      ANIM.crossfade(root, 'idle', 0)
    }
  }

  get doing() { return DOING[this.activity] || this.activity }
  get seated() { return !!(ACTS[this.activity] && ACTS[this.activity].seated) || this.activity === 'sitting' }
  get moving() { return !!this._move }

  describe() {
    return {
      id: this.id, name: this.name, role: this.role,
      activity: this.activity, doing: this.doing, clip: this.clip,
      state: this.state, destination: this.destination, busy: this.busy,
      x: +this.pos.x.toFixed(2), z: +this.pos.z.toFixed(2),
      yaw: +this.yaw.toFixed(2), speed: +this.speed.toFixed(3),
    }
  }

  // -- clips and labels ----------------------------------------------------

  /** Low-level: swap the clip, arm nothing. The demo drives beats with this. */
  play(clip, fade = 0.3) {
    if (this.clip === clip && !ANIM.ONE_SHOT.has(clip)) return this
    this.clip = clip
    const ts = clip === 'walk' ? Math.max(this.speed, 0.9 * this.natSpeed) / this.natSpeed : 1
    ANIM.crossfade(this.root, clip, fade, { timeScale: ts })
    // play() overrides the machine, so any transition it had armed is void.
    this._timer = null
    const a = ACT_OF_CLIP[clip]
    if (a) this.activity = a
    return this
  }

  /** State machine entry. Owns the clip AND what happens when it ends. */
  act(name, opts = {}) {
    const st = ACTS[name]
    if (!st) throw new Error('agent: no activity ' + name)
    // Both partners in a high five play the SAME clip: facing each other is
    // already the mirror. See highfive.js.
    const clip = st.clip
    const fade = opts.fade != null ? opts.fade : st.fade

    this.clip = clip
    ANIM.crossfade(this.root, clip, fade, { timeScale: name === 'walking' ? 0.05 : 1 })
    if (st.reverse) {
      // There is no stand-up clip, so sit runs backwards. LoopOnce clamps at 0.
      const a = ANIM.makeAction(this.root, clip, { timeScale: -1 })
      a.time = a.getClip().duration
    }
    this.activity = name
    if (name !== 'walking') this.speed = 0
    if (st.oneShot) {
      const next = opts.next !== undefined ? opts.next : st.next
      this._timer = { t: ANIM.getClip(clip).duration, fn: () => {
        if (opts.then) opts.then(this)
        else if (next) this.act(next)
      } }
    }
    return this
  }

  say(text, tone = 'ok') {
    this.badge.material.map.dispose()
    this.badge.material.map = badgeTexture(text, tone)
    this.badge.material.opacity = text ? 1 : 0
    this.badge.material.needsUpdate = true
    this.note = text || null
    return this
  }

  /** ok | working | blocked. Named by the demo; not the activity machine. */
  setState(s) {
    this.state = s
    this.halo.material.color.setStyle(TONE[s] || TONE.ok)
    this.halo.material.opacity = s === 'blocked' ? 0.95 : 0.55
    return this
  }

  stop() {
    this._move = null
    this._turn = null
    this._timer = null
    this.speed = 0
    this.destination = null
    if (this.activity === 'walking') this.act('idle')
    return this
  }

  // -- motion --------------------------------------------------------------

  /** Turn in place to an absolute (external-convention) yaw. */
  turnTo(targetYaw) {
    return new Promise(res => { this._turn = { target: targetYaw, done: res } })
  }

  faceTowards(tx, tz) {
    // External convention negates both components; see the header.
    return this.turnTo(Math.atan2(-(tx - this.pos.x), -(tz - this.pos.z)))
  }

  /**
   * Walk to (x, z). Steers with a turn rate instead of snapping to face the
   * target, decelerates on the approach, and settles into idle. Resolves once
   * it has arrived and finished settling to opts.yaw.
   */
  goTo(x, z, opts = {}) {
    if (this.seated) {
      // Get up first, then walk. The promise still resolves on final arrival.
      return this.standUp().then(() => this.#startMove(x, z, opts))
    }
    return this.#startMove(x, z, opts)
  }

  /** Reverse-plays sit. Resolves standing. */
  standUp() {
    return new Promise(res => {
      this.act('standing', { then: () => { this.act('idle'); res() } })
    })
  }

  /** Sit down at (x, z) facing yaw, then run `act` (default typing). */
  sitAt(x, z, yaw, next = 'typing') {
    return this.goTo(x, z, { yaw }).then(() => new Promise(res => {
      this.act('sitting', { then: () => { this.act(next); res() } })
    }))
  }

  #startMove(x, z, opts) {
    return new Promise(res => {
      this._move = {
        x, z,
        speed: opts.speed || TUNING.maxSpeed,
        endYaw: opts.yaw != null ? opts.yaw : (opts.facing != null ? opts.facing : null),
        then: opts.then || null,
        done: res,
      }
      this.destination = opts.label || null
      this._pivot = false
      this.act('walking')
    })
  }

  // -- per frame -----------------------------------------------------------

  update(dt) {
    this._pulse += dt

    if (this._timer) {
      this._timer.t -= dt
      if (this._timer.t <= 0) { const f = this._timer.fn; this._timer = null; f() }
    }

    if (this._move) this.#steer(dt)
    else if (this._turn) this.#turn(dt, TUNING.turnIdle)

    if (this.state === 'blocked') {
      const k = 0.5 + 0.5 * Math.sin(this._pulse * 7)
      this.halo.material.opacity = 0.55 + 0.42 * k
      this.halo.scale.setScalar(1 + 0.14 * k)
    } else {
      this.halo.scale.setScalar(1)
    }

    this.root.position.set(this.pos.x, 0, this.pos.z)
    this.root.rotation.y = this.yaw + YAW_OFFSET
    ANIM.update(this.root, dt)
  }

  #steer(dt) {
    const m = this._move
    const dx = m.x - this.pos.x, dz = m.z - this.pos.z
    const dist = Math.hypot(dx, dz)

    // Heading to the target, in the external yaw convention.
    const want = Math.atan2(-dx, -dz)
    let ang = wrapPi(want - this.yaw)

    // A tight target behind us cannot be reached on an arc — the turn circle is
    // wider than the distance and the agent orbits it forever. Pivot instead.
    if (!this._pivot && dist < TUNING.pivotDist && Math.abs(ang) > TUNING.pivotAngle) {
      this._pivot = true
      this.play('idle', 0.2)
    } else if (this._pivot && Math.abs(ang) < TUNING.pivotExit) {
      this._pivot = false
      this.act('walking')
    }

    const rate = this._pivot ? TUNING.turnIdle : TUNING.turnWalk
    this.yaw = wrapPi(this.yaw + clamp(ang, -rate * dt, rate * dt))
    ang = wrapPi(want - this.yaw)

    let vmax = 0
    if (!this._pivot) {
      const turnFactor = Math.max(TUNING.minTurnFactor, 1 - Math.abs(ang) / 1.5)
      const stopping = Math.sqrt(2 * TUNING.decel * Math.max(0, dist - TUNING.arrive))
      vmax = Math.min(m.speed * turnFactor, stopping)
    }
    this.speed += clamp(vmax - this.speed, -TUNING.decel * dt, TUNING.accel * dt)
    if (this.speed < 0) this.speed = 0

    // Travel along the heading, not the line to the target, so a turn reads as
    // an arc and not a crab walk. External yaw means forward is -(sin, cos).
    this.pos.x -= Math.sin(this.yaw) * this.speed * dt
    this.pos.z -= Math.cos(this.yaw) * this.speed * dt

    if (this.clip === 'walk') {
      // The no-foot-slide equation.
      ANIM.makeAction(this.root, 'walk').timeScale =
        clamp(this.speed / this.natSpeed, 0.05, 1.8)
    }

    if (dist <= TUNING.arrive + 0.03 && this.speed < 0.18) this.#arrive()
  }

  #arrive() {
    const m = this._move
    this._move = null
    this._pivot = false
    this.speed = 0
    this.destination = null
    this.act('idle')

    const finish = () => {
      if (m.then) m.then(this)
      if (m.done) m.done(this)
      if (this.world) this.world.onArrived(this)
    }
    if (m.endYaw != null) this.turnTo(m.endYaw).then(finish)
    else finish()
  }

  #turn(dt, rate) {
    const d = wrapPi(this._turn.target - this.yaw)
    if (Math.abs(d) < 0.02) {
      this.yaw = this._turn.target
      const done = this._turn.done; this._turn = null
      if (done) done(this)
      return
    }
    this.yaw = wrapPi(this.yaw + clamp(d, -rate * dt, rate * dt))
  }
}

export function createAgent(opts) { return new Agent(opts) }

// ---------------------------------------------------------------------------
// World: owns the agents, runs paired actions.
// ---------------------------------------------------------------------------

export class World {
  constructor() {
    this.agents = []
    this.encounters = []
    this.time = 0
    this.greetings = true
  }

  add(agent) { agent.world = this; this.agents.push(agent); return agent }
  byId(id) { return this.agents.find(a => a.id === id) }
  byName(n) { return this.agents.find(a => a.name === n) }

  /** Drop an agent that has gone quiet (TTL expiry). Ends any encounter it
   *  was in first, so the partner is not left mid-animation with nobody
   *  there. Caller still owns the THREE side (root, meshes, pick proxy). */
  remove(agent) {
    for (const e of this.encounters) {
      if (e.a === agent || e.b === agent) this.#end(e)
    }
    this.encounters = this.encounters.filter(e => e.phase !== 'done')
    const i = this.agents.indexOf(agent)
    if (i >= 0) this.agents.splice(i, 1)
    agent.world = null
  }

  update(dt) {
    this.time += dt
    for (const a of this.agents) a.update(dt)
    for (const e of this.encounters) this.#step(e, dt)
    this.encounters = this.encounters.filter(e => e.phase !== 'done')
  }

  /** Called by an agent the moment it finishes a walk. */
  onArrived(agent) {
    if (!this.greetings || agent.busy) return
    // Only an arrival that ended in plain standing is up for a greeting; one
    // that arrived in order to sit down has somewhere to be.
    if (agent.activity !== 'idle') return
    if (this.time - agent.lastGreet < TUNING.greetCooldown) return
    const other = this.agents.find(b =>
      b !== agent && !b.busy && !b.seated && b.activity === 'idle' && !b.moving &&
      this.time - b.lastGreet >= TUNING.greetCooldown &&
      Math.hypot(b.pos.x - agent.pos.x, b.pos.z - agent.pos.z) < TUNING.greetRange)
    if (other) this.highfive(agent, other)
  }

  /**
   * Walk two agents onto the marks highfive.js computes, turn them to face,
   * then fire the paired clip on the same frame. The marks are HIGHFIVE_SPACING
   * apart (scaled to the pair's height), which is the separation the clip was
   * solved for: further and the palms miss. See highfive.js for why this
   * lands the contact — this is just the goTo/act plumbing around it.
   */
  highfive(a, b) {
    if (!a || !b || a === b || a.busy || b.busy) return null
    const height = (a.height + b.height) / 2
    const marks = highfiveMarks(
      new THREE.Vector3(a.pos.x, 0, a.pos.z),
      new THREE.Vector3(b.pos.x, 0, b.pos.z),
      spacingFor(height))
    const ax = marks.a.pos.x, az = marks.a.pos.z
    const bx = marks.b.pos.x, bz = marks.b.pos.z

    a.busy = b.busy = true
    a.lastGreet = b.lastGreet = this.time
    // marks.*.yaw is in highfive.js's own (rig-facing) convention; goTo wants
    // the external one, so re-derive it from the mark positions.
    a.goTo(ax, az, { yaw: yawToward(ax, az, bx, bz), label: 'meeting ' + b.name })
    b.goTo(bx, bz, { yaw: yawToward(bx, bz, ax, az), label: 'meeting ' + a.name })

    const e = { a, b, kind: 'highfive', phase: 'approach', t: 0, marks: { a:[ax, az], b:[bx, bz] } }
    this.encounters.push(e)
    return e
  }

  /**
   * The rung-3 "wait" resolution beat: the requester agreed to hold off, no
   * animosity, so it's a handshake — a plain office "you go ahead". Same
   * shape as highfive() exactly (same-frame same-clip pair, marks from
   * clips/handshake.js's own spacing), just a different clip and a different
   * ACTS entry. See clips/handshake.js for why this reuses highfive's
   * "both play the SAME clip, facing each other is already the mirror" trick.
   */
  handshake(a, b) {
    if (!a || !b || a === b || a.busy || b.busy) return null
    const height = (a.height + b.height) / 2
    const marks = handshakeMarks(
      new THREE.Vector3(a.pos.x, 0, a.pos.z),
      new THREE.Vector3(b.pos.x, 0, b.pos.z),
      handshakeSpacingFor(height))
    const ax = marks.a.pos.x, az = marks.a.pos.z
    const bx = marks.b.pos.x, bz = marks.b.pos.z

    a.busy = b.busy = true
    a.lastGreet = b.lastGreet = this.time
    a.goTo(ax, az, { yaw: yawToward(ax, az, bx, bz), label: 'settling with ' + b.name })
    b.goTo(bx, bz, { yaw: yawToward(bx, bz, ax, az), label: 'settling with ' + a.name })

    const e = { a, b, kind: 'handshake', phase: 'approach', t: 0, marks: { a:[ax, az], b:[bx, bz] } }
    this.encounters.push(e)
    return e
  }

  /**
   * Walk two agents onto the argue marks (clips/argue.js's spacing, same
   * geometry idea as highfive's) and start the contested-write pair: `a`
   * points, `b` throws its hands up. Unlike highfive() this has no natural
   * end — a rung 3 collision lasts until the region is free, not for a fixed
   * clip length — so it loops until resolveContest() is called on the
   * returned encounter.
   */
  contest(a, b) {
    if (!a || !b || a === b || a.busy || b.busy) return null
    const height = (a.height + b.height) / 2
    const marks = argueMarks(
      new THREE.Vector3(a.pos.x, 0, a.pos.z),
      new THREE.Vector3(b.pos.x, 0, b.pos.z),
      argueSpacingFor(height))
    const ax = marks.a.pos.x, az = marks.a.pos.z
    const bx = marks.b.pos.x, bz = marks.b.pos.z

    a.busy = b.busy = true
    a.goTo(ax, az, { yaw: yawToward(ax, az, bx, bz), label: 'contesting with ' + b.name })
    b.goTo(bx, bz, { yaw: yawToward(bx, bz, ax, az), label: 'contesting with ' + a.name })

    const e = { a, b, kind: 'contest', phase: 'approach', t: 0, marks: { a:[ax, az], b:[bx, bz] } }
    this.encounters.push(e)
    return e
  }

  /**
   * The rung-3 "abort" resolution beat: `a` out-authoritied `b` — wait-die
   * aborted the younger transaction, or a straight priority-tier win — and
   * `a` makes sure `b` knows it. Asymmetric like contest(), but this one has
   * a natural end: it plays out once and is done, same as highfive(). `a` is
   * always the winner.
   */
  shove(a, b) {
    if (!a || !b || a === b || a.busy || b.busy) return null
    const height = (a.height + b.height) / 2
    const marks = shoveMarks(
      new THREE.Vector3(a.pos.x, 0, a.pos.z),
      new THREE.Vector3(b.pos.x, 0, b.pos.z),
      shoveSpacingFor(height))
    const ax = marks.a.pos.x, az = marks.a.pos.z
    const bx = marks.b.pos.x, bz = marks.b.pos.z

    a.busy = b.busy = true
    a.goTo(ax, az, { yaw: yawToward(ax, az, bx, bz), label: 'pulling rank on ' + b.name })
    b.goTo(bx, bz, { yaw: yawToward(bx, bz, ax, az), label: 'shoved by ' + a.name })

    const e = { a, b, kind: 'shove', phase: 'approach', t: 0, marks: { a:[ax, az], b:[bx, bz] } }
    this.encounters.push(e)
    return e
  }

  /**
   * The rung-1 beat: `a` is the reader, noticing `b` (the editor) is
   * already in there, and gets out of the way. Asymmetric like shove() —
   * two different clips, phase-matched — but there's no winner/loser
   * framing here, just a reader standing down. See clips/yield.js.
   */
  yield(a, b) {
    if (!a || !b || a === b || a.busy || b.busy) return null
    const height = (a.height + b.height) / 2
    const marks = yieldMarks(
      new THREE.Vector3(a.pos.x, 0, a.pos.z),
      new THREE.Vector3(b.pos.x, 0, b.pos.z),
      yieldSpacingFor(height))
    const ax = marks.a.pos.x, az = marks.a.pos.z
    const bx = marks.b.pos.x, bz = marks.b.pos.z

    a.busy = b.busy = true
    a.goTo(ax, az, { yaw: yawToward(ax, az, bx, bz), label: 'yielding to ' + b.name })
    b.goTo(bx, bz, { yaw: yawToward(bx, bz, ax, az), label: 'keeping the file' })

    const e = { a, b, kind: 'yield', phase: 'approach', t: 0, marks: { a:[ax, az], b:[bx, bz] } }
    this.encounters.push(e)
    return e
  }

  /**
   * The rung-4 beat: `a` and `b` discover they duplicated each other's
   * work. Symmetric, same shape as highfive()/handshake() — same clip,
   * mirrored by facing. See clips/doubletake.js.
   */
  doubletake(a, b) {
    if (!a || !b || a === b || a.busy || b.busy) return null
    const height = (a.height + b.height) / 2
    const marks = doubletakeMarks(
      new THREE.Vector3(a.pos.x, 0, a.pos.z),
      new THREE.Vector3(b.pos.x, 0, b.pos.z),
      doubletakeSpacingFor(height))
    const ax = marks.a.pos.x, az = marks.a.pos.z
    const bx = marks.b.pos.x, bz = marks.b.pos.z

    a.busy = b.busy = true
    a.lastGreet = b.lastGreet = this.time
    a.goTo(ax, az, { yaw: yawToward(ax, az, bx, bz), label: 'noticing ' + b.name })
    b.goTo(bx, bz, { yaw: yawToward(bx, bz, ax, az), label: 'noticing ' + a.name })

    const e = { a, b, kind: 'doubletake', phase: 'approach', t: 0, marks: { a:[ax, az], b:[bx, bz] } }
    this.encounters.push(e)
    return e
  }

  /** End a contest before it would end on its own — the region freed up, or
   *  one side went quiet. No-op on anything else (already done, or a plain
   *  highfive, which resolves itself). */
  resolveContest(e) {
    if (e && e.kind === 'contest' && e.phase !== 'done') this.#end(e)
  }

  #step(e, dt) {
    const { a, b } = e
    e.t += dt
    if (e.phase === 'approach') {
      if (e.t > 14) return this.#end(e)                 // never hang forever
      if (!a.moving && !b.moving && !a._turn && !b._turn && !a.seated && !b.seated) {
        // Arrival has a tolerance, so each of them can stop up to 10cm short.
        // Two of those and the pair stands 20cm too far apart, which is enough
        // to make the palms (or, for a contest, the marks) miss. Ease them
        // onto the exact marks first.
        e.phase = 'settle'; e.t = 0
        e.from = { a:[a.pos.x, a.pos.z], b:[b.pos.x, b.pos.z] }
      }
    } else if (e.phase === 'settle') {
      const k = Math.min(1, e.t / 0.28)
      const s = k * k * (3 - 2 * k)
      for (const key of ['a', 'b']) {
        const ag = e[key], f = e.from[key], m = e.marks[key]
        ag.pos.x = f[0] + (m[0] - f[0]) * s
        ag.pos.z = f[1] + (m[1] - f[1]) * s
      }
      if (k >= 1) {
        e.phase = 'active'; e.t = 0
        if (e.kind === 'contest') {
          // Different bodies doing different things — one points, the other
          // throws its hands up — but started the same frame, the same sync
          // story highfive's SAME clip trick tells; see clips/argue.js.
          a.act('arguing')
          b.act('reacting')
        } else if (e.kind === 'shove') {
          // Asymmetric like contest — the winner shoves, the loser eats it —
          // but this one has a fixed length; see clips/shove.js.
          a.act('shoving')
          b.act('shoveReacting')
        } else if (e.kind === 'yield') {
          // Asymmetric like shove — reader and editor play different
          // clips — but neither one "wins"; see clips/yield.js.
          a.act('yielding')
          b.act('keeping')
        } else {
          // highfive, handshake, doubletake: same frame, same fade, both
          // from time zero, both the SAME clip — facing each other is
          // already the mirror. That is the whole sync story; see
          // highfive.js.
          const sameClipAct = { handshake: 'handshaking', doubletake: 'doubletaking' }[e.kind] || 'highfiving'
          a.act(sameClipAct)
          b.act(sameClipAct)
        }
      }
    } else if (e.phase === 'active') {
      // A contest has no clip-length end: it lasts until resolveContest()
      // says the region is free. Everything else (highfive, handshake,
      // shove, yield, doubletake) plays out once and ends on its own
      // clip's length.
      const CLIP_OF_KIND = {
        highfive: 'highfive', handshake: 'handshake', shove: 'shove',
        yield: 'yieldStep', doubletake: 'doubletake',
      }
      const clipName = CLIP_OF_KIND[e.kind]
      if (clipName && e.t >= ANIM.getClip(clipName).duration + 0.2) {
        return this.#end(e)
      }
    }
  }

  #end(e) {
    e.phase = 'done'
    e.a.busy = e.b.busy = false
    e.a.lastGreet = e.b.lastGreet = this.time
    if (!e.a.moving && e.a.activity !== 'idle') e.a.act('idle')
    if (!e.b.moving && e.b.activity !== 'idle') e.b.act('idle')
  }
}

/** Yaw that makes a character at (fx,fz) face (tx,tz), external convention. */
export function yawToward(fx, fz, tx, tz) {
  return Math.atan2(-(tx - fx), -(tz - fz))
}
