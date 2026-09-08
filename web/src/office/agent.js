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
// only guarantees the average is right. #steer is the ONLY place that sets
// the walk action's timeScale — nowhere else should touch it, or the two
// values fight and whichever wrote last wins for one frame.
//
// Turning in place (see pivot in #steer, and the same branch reused by
// #settle for a big leftover heading error after arrival) has no ground
// speed to solve against, so it isn't the no-slip equation above — it plays
// the same walk clip at a cadence proportional to how far off-heading we
// still are, with the body's world position held fixed. The walk clip's
// Hips.position track is exactly periodic (first key == last key, verified
// directly off the baked keyframe data) so holding position doesn't
// accumulate drift, just a stepping-in-place wobble, which reads better than
// freezing to idle mid-turn.
// ---------------------------------------------------------------------------

import * as THREE from 'three'
import * as ANIM from './anim.js'
import { highfiveMarks, spacingFor } from './highfive.js'
import { argueMarks, spacingFor as argueSpacingFor } from './clips/argue.js'
import { handshakeMarks, spacingFor as handshakeSpacingFor } from './clips/handshake.js'
import { shoveMarks, spacingFor as shoveSpacingFor } from './clips/shove.js'
import { yieldMarks, spacingFor as yieldSpacingFor } from './clips/yield.js'
import { doubletakeMarks, spacingFor as doubletakeSpacingFor } from './clips/doubletake.js'
// Rung-2 "collaboration" beat family — alternates to highfive. See
// clips/chestbump.js / clips/fistbump.js headers.
import { chestbumpMarks, spacingFor as chestbumpSpacingFor } from './clips/chestbump.js'
import { fistbumpMarks, spacingFor as fistbumpSpacingFor } from './clips/fistbump.js'
// Rung-3 "abort"/out-authoritied beat family — alternates to shove. See
// clips/waveoff.js / clips/slap.js headers.
import { waveoffMarks, spacingFor as waveoffSpacingFor } from './clips/waveoff.js'
import { slapMarks, spacingFor as slapSpacingFor } from './clips/slap.js'
import * as Z from './zones.js'

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
  arrive: 0.01,        // m — #steer's trigger radius, tested against the distance at the TOP of the frame
  arriveSpeed: 0.16,   // m/s — speed must also be under this for #arrive to fire, so #settle's
                       // glide cap has a hand-off it can absorb. Both gates bind — see #arrive.
  pivotDist: 1.0,      // inside this, a big turn is done on the spot
  pivotAngle: 1.0,
  pivotExit: 0.35,
  settle: 0.28,        // s — floor on the final glide's duration; only stretched longer when
                       // glideSpeed/turnIdle below would otherwise be exceeded
  glideSpeed: 0.045,   // m/s cap on #settle's position glide, so arrival doesn't read as a
                       // foot slide under the idle clip
  greetRange: 2.6,     // two arrivals this close will high five
  greetCooldown: 8.0,  // s
}

/** Stable per-agent seed for ANIM.setSeed, so characters sharing a clip don't
 *  move in lockstep. FNV-1a over the id — deterministic across runs, not
 *  just this session, since ids are assigned by the caller (office.html),
 *  not sequentially here. */
function seedFromId(id) {
  let h = 0x811c9dc5
  for (let i = 0; i < id.length; i++) {
    h ^= id.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return h >>> 0
}

// Each activity owns its clip, its blend time and where it goes when it ends.
// Whether a clip is a one-shot is the clip's own business — anim.js's buildClip
// derives it from the spec's `loop` — so it isn't restated here. `next` is only
// read for the ones that are, and they're timed off the clip length.
const ACTS = {
  idle:       { clip: 'idle',     fade: 0.35 },
  walking:    { clip: 'walk',     fade: 0.28 },
  sitting:    { clip: 'sit',      fade: 0.30, next: 'typing' },
  standing:   { clip: 'sit',      fade: 0.30, next: 'idle', reverse: true },
  typing:     { clip: 'type',     fade: 0.45, seated: true },
  sleeping:   { clip: 'sleep',    fade: 0.60, seated: true },
  reading:    { clip: 'read',     fade: 0.45 },
  drinking:   { clip: 'drink',    fade: 0.45 },
  waving:     { clip: 'wave',     fade: 0.30 },
  highfiving: { clip: 'highfive', fade: 0.20, next: 'idle' },
  // The contested-write pair. Not a one-shot: it loops until World.resolveContest()
  // ends it, because unlike a high five a real collision has no fixed length —
  // it lasts until the region is free. clips/argue.js supplies 'argue' and
  // 'argueReact' once World.contest() folds them into ANIM.CLIPS.
  arguing:    { clip: 'argue',      fade: 0.25 },
  reacting:   { clip: 'argueReact', fade: 0.25 },
  // Resolution beats — the reel plays these once a rung-3 collision clears.
  // Rung 3, decision "wait": the requester agreed to hold off. clips/handshake.js.
  handshaking: { clip: 'handshake', fade: 0.20, next: 'idle' },
  // Rung 3, decision "abort": wait-die or a straight priority-tier win.
  // clips/shove.js — `shoving` is the winner, `shoveReacting` the loser.
  shoving:        { clip: 'shove',      fade: 0.18, next: 'idle' },
  shoveReacting:  { clip: 'shoveReact', fade: 0.18, next: 'idle' },
  // Rung 3 "abort" beat family, alternates to shoving/shoveReacting above:
  // same asymmetric a-wins convention, different beats. clips/waveoff.js
  // (no contact, all contempt) / clips/slap.js (cartoon wind-up and hit).
  wavingOff:       { clip: 'waveoff',      fade: 0.20, next: 'idle' },
  waveoffReacting: { clip: 'waveoffReact', fade: 0.20, next: 'idle' },
  slapping:        { clip: 'slap',         fade: 0.14, next: 'idle' },
  slapReacting:    { clip: 'slapReact',    fade: 0.14, next: 'idle' },
  // Rung 1: the reader notices the editor is already in there and steps
  // back. clips/yield.js — `yielding` is the reader, `keeping` the editor.
  yielding: { clip: 'yieldStep', fade: 0.18, next: 'idle' },
  keeping:  { clip: 'yieldKeep', fade: 0.18, next: 'idle' },
  // Rung 4: redundant work caught by similarity — same beat both sides,
  // mirrored. clips/doubletake.js.
  doubletaking: { clip: 'doubletake', fade: 0.16, next: 'idle' },
  // Rung 2 collaboration beat family, alternates to highfiving above: both
  // sides play the same clip, same "facing each other is the mirror" trick.
  // clips/chestbump.js (bigger, weightier) / clips/fistbump.js (understated).
  chestbumping: { clip: 'chestbump', fade: 0.20, next: 'idle' },
  fistbumping:  { clip: 'fistbump',  fade: 0.16, next: 'idle' },
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
  chestbump: 'chestbumping', fistbump: 'fistbumping',
  waveoff: 'wavingOff', waveoffReact: 'waveoffReacting',
  slap: 'slapping', slapReact: 'slapReacting',
}

const DOING = {
  idle: 'standing by', walking: 'walking', sitting: 'sitting down',
  standing: 'getting up', typing: 'typing', sleeping: 'asleep at the desk',
  reading: 'reading', drinking: 'on a break', waving: 'waving',
  highfiving: 'high fiving', arguing: 'arguing over it', reacting: 'not having it',
  handshaking: 'shaking on it', shoving: 'pulling rank', shoveReacting: 'shoved aside',
  yielding: 'stepping back', keeping: 'keeping at it', doubletaking: 'wait, you too?',
  wavingOff: 'waving them off', waveoffReacting: 'brushed off',
  slapping: 'making a point', slapReacting: 'seeing stars',
}

const TONE = {
  ok: '#35455C', working: '#C0762A', blocked: '#D9714F',
  idle: '#8A94A3', done: '#4A1F3D',
}

// Freshness is a second, orthogonal halo channel — not TONE. TONE says what
// the agent is doing right now (ok/working/blocked); freshness says how old
// the ground they're standing on is (git stat's lastAgeDays). Both ride the
// feet at once: TONE owns the inner ring's color, freshness owns an outer
// ring's color/radius/pulse rate. An agent editing code from this morning
// should not read the same as one editing a file nobody's touched all year.
const FRESH = {
  fresh:  { color: '#E8946C', radius: 1.34, pulse: 2.6, opacity: 0.46 }, // <2d: warm, big, quick
  warm:   { color: '#D6B45C', radius: 1.14, pulse: 1.5, opacity: 0.34 }, // <21d
  normal: { color: '#8A94A3', radius: 1.00, pulse: 0.9, opacity: 0.16 }, // <180d, barely there
  stale:  { color: '#3E4A5E', radius: 0.86, pulse: 0.35, opacity: 0.24 }, // >=180d: cold, small, slow
}

// Churn is the third signal, separate from both TONE and FRESH: freshness
// says how OLD the ground under an agent is, churn says how FAST it is
// moving right now (gitsignals.js's churnToIntensity, working-tree diff
// weighted over 14-day history). It shows up two ways — see setChurn() and
// update() below — a subtle typing-speed bump and a paper stack that grows
// on the desk beside them. Ranges picked to read as "busier", never
// "broken": the fastest typing is 1.6x, not a caffeinated blur.
const CHURN_TYPE_SPEED = [1.0, 1.6]   // idle..maxed-out typing timeScale
const CHURN_EASE = 2.2                 // 1/s, how fast _churn chases its target
const CHURN_MAX_H = 0.22               // metres, tallest the paper stack gets
// Desk surfaces sit at office.html's DESK_TOP (0.76m). The stack is a decoration
// riding the agent root, not a real desk-relative object (agent.js has no
// reference to which desk mesh an agent is at), so this is a fixed guess at
// "about desk height, off to one side" rather than a measured position.
const CHURN_BASE_Y = 0.74

/** ageDays -> a FRESH bucket name, or null for "no signal, show nothing".
 *  Pure so it's unit-testable without a THREE scene. */
export function freshnessBucket(ageDays) {
  if (ageDays == null || !Number.isFinite(ageDays) || ageDays < 0) return null
  if (ageDays < 2) return 'fresh'
  if (ageDays < 21) return 'warm'
  if (ageDays < 180) return 'normal'
  return 'stale'
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
    this._settle = null                   // { from, to, fromYaw, toYaw, t, m }, see #settle
    this._timer = null                    // { t, fn }, frame-locked so stop() kills it
    this._pivot = false
    this._walkTs = null                   // rate-limited walk timeScale, see #steer
    this._pulse = 0
    this.seed = seedFromId(this.id)

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

    // Outer ring for the freshness channel. Starts invisible (opacity 0,
    // bucket null) until setFreshness() has something to say.
    this.freshHalo = new THREE.Mesh(
      new THREE.RingGeometry(0.46, 0.58, 32),
      new THREE.MeshBasicMaterial({ color: 0x8A94A3, transparent: true, opacity: 0,
        depthWrite: false, side: THREE.DoubleSide }))
    this.freshHalo.rotation.x = -Math.PI / 2
    this.freshHalo.position.y = 0.05
    this.freshHalo.renderOrder = 2
    this.freshHalo.userData.decor = true
    this._freshness = null
    this._freshPulse = 0

    // Churn prop: a tray plus a block whose height IS the eased churn value,
    // so it grows continuously instead of popping in sheet by sheet. Both
    // start fully transparent (0 papers at intensity 0) and scale up from
    // the tray's surface, never from the block's own center, so it reads as
    // stacking UP rather than swelling from the middle.
    this._churn = 0
    this._churnTarget = 0
    this.churnGroup = new THREE.Group()
    this.churnGroup.position.set(0.34 * scale, 0, 0.22 * scale)
    this.churnGroup.userData.decor = true
    this.churnTray = new THREE.Mesh(
      new THREE.BoxGeometry(0.30, 0.03, 0.22),
      new THREE.MeshStandardMaterial({ color: 0xC3B39B, roughness: 0.9, transparent: true, opacity: 0, depthWrite: false }))
    this.churnTray.position.y = CHURN_BASE_Y * scale
    this.churnPapers = new THREE.Mesh(
      new THREE.BoxGeometry(0.26, 1, 0.18), // unit height; scale.y IS the stack height in metres
      new THREE.MeshStandardMaterial({ color: 0xFFFDFA, roughness: 0.85, transparent: true, opacity: 0, depthWrite: false }))
    this.churnPapers.position.y = CHURN_BASE_Y * scale + 0.02
    this.churnPapers.scale.y = 0.0001
    this.churnGroup.add(this.churnTray, this.churnPapers)

    if (root) {
      ANIM.setSeed(root, this.seed)
      root.add(this.badge)
      root.add(this.halo)
      root.add(this.freshHalo)
      root.add(this.churnGroup)
      root.position.set(this.pos.x, 0, this.pos.z)
      root.rotation.y = this.yaw + YAW_OFFSET
      ANIM.crossfade(root, 'idle', 0)
    }
  }

  get doing() { return DOING[this.activity] || this.activity }
  get seated() { return !!(ACTS[this.activity] && ACTS[this.activity].seated) || this.activity === 'sitting' }
  /** In transit: still walking, or still ironing out the last few
   *  centimetres and degrees of an arrival (#settle keeps gliding and
   *  turning for up to ~1.4s after _move clears). Both read as motion on
   *  screen, so anything picking a free agent or waiting for one to stop has
   *  to wait out the settle too. */
  get moving() { return !!(this._move || this._settle) }

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

  /** Low-level: swap the clip, arm nothing. The demo drives beats with this.
   *  Walk timeScale is NOT set here — #steer owns it, every frame, while an
   *  agent is actually steering itself, and it writes the cached action's
   *  timeScale directly. So a play('walk') outside a steer (a demo beat, say)
   *  inherits whatever rate the last steer or pivot left on that action. */
  play(clip, fade = 0.3) {
    if (this.clip === clip && !ANIM.getClip(clip).userData.oneShot) return this
    this.clip = clip
    ANIM.crossfade(this.root, clip, fade)
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
    // No timeScale override for 'walking' here — #steer sets it every frame
    // from the actual speed (see FEET, up top); this call runs the instant
    // before #steer's first tick, so whatever crossfade's default (1) starts
    // with is corrected within a frame.
    ANIM.crossfade(this.root, clip, fade)
    if (st.reverse) {
      // There is no stand-up clip, so sit runs backwards. LoopOnce clamps at 0.
      const a = ANIM.makeAction(this.root, clip, { timeScale: -1 })
      a.time = a.getClip().duration
    }
    this.activity = name
    if (name !== 'walking') this.speed = 0
    const c = ANIM.getClip(clip)
    if (c.userData.oneShot) {
      const next = opts.next !== undefined ? opts.next : st.next
      this._timer = { t: c.duration, fn: () => {
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

  /** ageDays of the last commit touching whatever this agent is holding, or
   *  null to clear the ring (unknown / no gitPath / lookup failed). Orthogonal
   *  to setState — see the FRESH table above. */
  setFreshness(ageDays) {
    this._freshness = freshnessBucket(ageDays)
    if (!this._freshness) {
      this.freshHalo.material.opacity = 0
      return this
    }
    const cfg = FRESH[this._freshness]
    this.freshHalo.material.color.setStyle(cfg.color)
    return this
  }

  /** intensity 0..1 from gitsignals.js's churnToIntensity: how much this
   *  agent's current file has moved lately. Only sets a target — update()
   *  eases toward it every frame (CHURN_EASE), so a poll landing mid-typing
   *  never snaps the animation speed or the paper stack. */
  setChurn(intensity) {
    this._churnTarget = clamp(Number.isFinite(intensity) ? intensity : 0, 0, 1)
    return this
  }

  stop() {
    this.#cancelMove()
    this._turn = null
    this._timer = null
    this.speed = 0
    this.destination = null
    if (this.activity === 'walking') this.act('idle')
    return this
  }

  /** Settle a superseded goTo's promise with a falsy value instead of
   *  leaving it pending forever. A new order (#startMove) or stop() calling
   *  this while the old one is still mid-flight (walking OR easing onto its
   *  mark in #settle) means the old arrival never really happened — resolve
   *  it anyway, just with `null` instead of `this`, so a chained .then (see
   *  sitAt) can tell the difference and bail instead of acting on a stale
   *  order. opts.then is NOT run and World.onArrived is NOT called: both are
   *  "what happens after this specific arrival", which a cancelled arrival
   *  never had. */
  #cancelMove() {
    if (this._settle) {
      const done = this._settle.m.done
      this._settle = null
      if (done) done(null)
    } else if (this._move) {
      const done = this._move.done
      this._move = null
      if (done) done(null)
    }
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
    return this.goTo(x, z, { yaw }).then(arrived => {
      // A falsy resolve (#cancelMove) means some later order superseded this
      // walk before it ever got here — don't sit down wherever that left us.
      if (!arrived) return null
      return new Promise(res => {
        this.act('sitting', { then: () => { this.act(next); res(this) } })
      })
    })
  }

  #startMove(x, z, opts) {
    this.#cancelMove()   // a fresh order supersedes whatever the last one was chasing
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
      this._walkTs = null    // fresh walk: snap to the real speed, don't ease in from a stale rate
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
    else if (this._settle) this.#settle(dt)
    else if (this._turn) this.#turn(dt, TUNING.turnIdle)

    if (this.state === 'blocked') {
      const k = 0.5 + 0.5 * Math.sin(this._pulse * 7)
      this.halo.material.opacity = 0.55 + 0.42 * k
      this.halo.scale.setScalar(1 + 0.14 * k)
    } else {
      this.halo.scale.setScalar(1)
    }

    if (this._freshness) {
      const cfg = FRESH[this._freshness]
      this._freshPulse += dt * cfg.pulse
      const k = 0.5 + 0.5 * Math.sin(this._freshPulse)
      this.freshHalo.material.opacity = cfg.opacity * (0.7 + 0.3 * k)
      this.freshHalo.scale.setScalar(cfg.radius * (0.96 + 0.06 * k))
    }

    // Ease _churn toward whatever setChurn() last requested — never snap it,
    // a poll landing mid-keystroke should not visibly jump the typing speed.
    this._churn += (this._churnTarget - this._churn) * Math.min(1, dt * CHURN_EASE)
    if (this._churn > 0.004) {
      const h = CHURN_MAX_H * this._churn
      this.churnPapers.visible = true
      this.churnTray.visible = true
      this.churnPapers.scale.y = h
      this.churnPapers.position.y = this.churnTray.position.y + 0.02 + h / 2
      this.churnPapers.material.opacity = 0.25 + 0.65 * this._churn
      this.churnTray.material.opacity = 0.2 + 0.5 * this._churn
    } else {
      this.churnPapers.visible = false
      this.churnTray.visible = false
    }
    // Typing reads faster on a hot file — only while actually typing, so an
    // idle/walking agent doesn't carry a phantom speed-up. See CHURN_TYPE_SPEED.
    if (this.activity === 'typing') {
      const [lo, hi] = CHURN_TYPE_SPEED
      ANIM.setTimeScale(this.root, 'type', lo + (hi - lo) * this._churn)
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
    // wider than the distance and the agent orbits it forever. Pivot instead:
    // keep the clip on 'walk' (never idle) and let the timeScale block below
    // turn the stepping cadence down instead of freezing the legs.
    if (!this._pivot && dist < TUNING.pivotDist && Math.abs(ang) > TUNING.pivotAngle) {
      this._pivot = true
    } else if (this._pivot && Math.abs(ang) < TUNING.pivotExit) {
      this._pivot = false
    }

    const rate = this._pivot ? TUNING.turnIdle : TUNING.turnWalk
    this.yaw = wrapPi(this.yaw + clamp(ang, -rate * dt, rate * dt))
    ang = wrapPi(want - this.yaw)

    let vmax = 0
    if (!this._pivot) {
      const turnFactor = Math.max(TUNING.minTurnFactor, 1 - Math.abs(ang) / 1.5)
      // Brakes to a literal stop at the target, not a buffer TUNING.arrive
      // short of it — the old "- TUNING.arrive" here is what used to leave
      // up to ~10cm for #settle to glide through at idle-clip foot-slide
      // speeds. #settle now only has TUNING.arrive itself (1cm) left to close.
      const stopping = Math.sqrt(2 * TUNING.decel * dist)
      vmax = Math.min(m.speed * turnFactor, stopping)
    }
    this.speed += clamp(vmax - this.speed, -TUNING.decel * dt, TUNING.accel * dt)
    if (this.speed < 0) this.speed = 0

    // Travel along the heading, not the line to the target, so a turn reads as
    // an arc and not a crab walk. External yaw means forward is -(sin, cos).
    this.pos.x -= Math.sin(this.yaw) * this.speed * dt
    this.pos.z -= Math.cos(this.yaw) * this.speed * dt

    if (this.clip === 'walk') {
      // Moving: the no-slip equation. Pivoting: there's no ground speed to
      // solve against, so cadence tracks how far off-heading we still are
      // instead, capped at a stepping-not-sprinting 0.6 — it only actually
      // tapers below that in the last stretch as |ang| closes in on
      // pivotExit, which is fine: most of a big turn SHOULD read as one
      // steady cadence, only easing down right at the hand-off back to real
      // walking. See #walkCadence for the rate limiting either way goes through.
      const target = this._pivot
        ? Math.min(0.6, Math.abs(ang) / TUNING.pivotAngle)
        : clamp(this.speed / this.natSpeed, 0.05, 1.8)
      this.#walkCadence(target, dt)
    }

    // `dist` is this frame's OPENING distance, deliberately: a frame of travel
    // at 10fps is longer than the 1cm radius, so testing where the frame ended
    // lets the agent step across the mark without ever landing inside it and
    // orbit forever (measured: it never arrives at all from 4 m at 10fps).
    if (dist <= TUNING.arrive && this.speed < TUNING.arriveSpeed) this.#arrive()
  }

  /** Rate-limited walk timeScale, shared by #steer's pivot branch and
   *  #settle's turn-in-place branch (see FEET, up top — this and #steer's
   *  no-slip write above are the only two places that ever touch it, and
   *  never both in the same frame since #steer and #settle are mutually
   *  exclusive in update()). 8/s is generous next to the ~0.06/frame the
   *  no-slip equation itself ever asks for under TUNING.accel/decel, so it
   *  never lags real acceleration, but it does smooth the pivot<->walk and
   *  walk<->settle seams, where the formulas on either side can disagree by
   *  a lot in one frame. */
  #walkCadence(target, dt) {
    const maxStep = 8 * dt
    this._walkTs = this._walkTs == null
      ? target
      : this._walkTs + clamp(target - this._walkTs, -maxStep, maxStep)
    ANIM.makeAction(this.root, 'walk').timeScale = this._walkTs
  }

  #arrive() {
    const m = this._move
    this._move = null
    this._pivot = false
    this.speed = 0
    this.destination = null

    const toYaw = m.endYaw != null ? m.endYaw : this.yaw
    // A big leftover heading error (sitAt seating someone facing away from
    // the direction they walked in, say) gets walked off at turnIdle in
    // #settle's turn-in-place branch before there's anything to glide — see
    // there. Dropping to idle here would have to un-drop a frame later, and
    // reads as a flicker; only do it now when there's no turn phase coming.
    if (Math.abs(wrapPi(toYaw - this.yaw)) < TUNING.pivotExit) this.act('idle')

    // Both halves of #steer's gate bind, and neither is decorative: without
    // the radius, speed alone fires on frame 1 of every move (speed starts at
    // 0); without the speed test, the hand-off happens at the braking
    // profile's own 0.21 m/s and #settle's 0.045 m/s glide cap turns that into
    // a stop dead. What's left here is the radius plus however far the agent
    // travelled during the frames it spent waiting on the speed — measured
    // over 4 m / 0.5 m / 5 cm / 2 cm walks: ~1cm at 60fps, up to 2cm at 10fps.
    this._settle = { to: [m.x, m.z], toYaw, gliding: false, m }
  }

  /**
   * Closes whatever #steer's arrive tolerance left uncorrected: position
   * onto the exact mark, yaw onto the exact final heading. Generalises what
   * used to be a bespoke correction World.highfive ran after the fact (see
   * there — it now just waits on this instead of re-doing it).
   *
   * Two phases, because a smoothstepped glide bounded to keep BOTH the
   * position speed and the yaw rate under their idle caps would, for a big
   * heading error (a pi flip from sitAt, say), need a multi-second glide —
   * which is a character standing still and slowly rotating, not walking.
   * So a big error is walked off first, same as #steer's pivot: live walk
   * clip, cadence off the remaining angle, position held. Only once the
   * error is down to pivotExit does the smoothstepped glide below run, and
   * by then it's small enough that the caps cost it almost no time.
   */
  #settle(dt) {
    const s = this._settle
    const remaining = wrapPi(s.toYaw - this.yaw)

    if (Math.abs(remaining) >= TUNING.pivotExit) {
      // #arrive left the clip on 'walk' (it only drops to idle when this
      // branch isn't needed), so there's nothing to (re)crossfade here.
      this.yaw = wrapPi(this.yaw + clamp(remaining, -TUNING.turnIdle * dt, TUNING.turnIdle * dt))
      this.#walkCadence(Math.min(0.6, Math.abs(remaining) / TUNING.pivotAngle), dt)
      return
    }

    // First tick down here, whether we fell through from the turn above or
    // never needed it: (re)base the glide off wherever we actually are now,
    // and size its duration off what's actually left, so neither axis's
    // peak rate can exceed the caps this whole method exists to enforce.
    if (!s.gliding) {
      s.gliding = true
      s.from = [this.pos.x, this.pos.z]
      s.fromYaw = this.yaw
      s.t = 0
      const dist = Math.hypot(s.to[0] - s.from[0], s.to[1] - s.from[1])
      s.dur = Math.max(TUNING.settle,
        1.5 * dist / TUNING.glideSpeed,
        1.5 * Math.abs(remaining) / TUNING.turnIdle)
      if (this.activity === 'walking') this.act('idle')
    }

    s.t += dt
    const k = Math.min(1, s.t / s.dur)
    const e = k * k * (3 - 2 * k)
    this.pos.x = s.from[0] + (s.to[0] - s.from[0]) * e
    this.pos.z = s.from[1] + (s.to[1] - s.from[1]) * e
    this.yaw = wrapPi(s.fromYaw + wrapPi(s.toYaw - s.fromYaw) * e)
    if (k >= 1) {
      this.pos.x = s.to[0]; this.pos.z = s.to[1]; this.yaw = wrapPi(s.toYaw)
      const m = s.m
      this._settle = null
      if (m.then) m.then(this)
      if (m.done) m.done(this)
      if (this.world) this.world.onArrived(this)
    }
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
// World.replay()'s stage tables — see the method's own doc for why this
// exists as a second, additive path rather than a rewrite of contest() /
// shove() / etc. Those methods and their standalone kind dispatch in #step
// are untouched; a chained encounter is flagged (e.isChain) and takes the
// branches added above instead.
// ---------------------------------------------------------------------------

/** Marks (standing spots) for each stage kind a replay chain can pass
 *  through. Purely spatial — see highfiveMarks: the marks straddle the
 *  midpoint of the pair's CURRENT positions, so which side ends up on
 *  marks.a vs marks.b has no winner/loser meaning by itself. That meaning
 *  comes entirely from each stage's own start() below. */
const STAGE_MARKS = {
  // The argue-like standoff every rung-3 replay opens on, before it
  // resolves. Reuses argue's own spacing — a beat, not the final contact.
  clash:      (pa, pb, h) => argueMarks(pa, pb, argueSpacingFor(h)),
  // The rung-1/4 pre-beat pause — same idea, same spacing, just no clip of
  // its own (see REPLAY_CHAINS).
  notice:     (pa, pb, h) => argueMarks(pa, pb, argueSpacingFor(h)),
  handshake:  (pa, pb, h) => handshakeMarks(pa, pb, handshakeSpacingFor(h)),
  shove:      (pa, pb, h) => shoveMarks(pa, pb, shoveSpacingFor(h)),
  highfive:   (pa, pb, h) => highfiveMarks(pa, pb, spacingFor(h)),
  yield:      (pa, pb, h) => yieldMarks(pa, pb, yieldSpacingFor(h)),
  doubletake: (pa, pb, h) => doubletakeMarks(pa, pb, doubletakeSpacingFor(h)),
  chestbump:  (pa, pb, h) => chestbumpMarks(pa, pb, chestbumpSpacingFor(h)),
  fistbump:   (pa, pb, h) => fistbumpMarks(pa, pb, fistbumpSpacingFor(h)),
  waveoff:    (pa, pb, h) => waveoffMarks(pa, pb, waveoffSpacingFor(h)),
  slap:       (pa, pb, h) => slapMarks(pa, pb, slapSpacingFor(h)),
}

// ---------------------------------------------------------------------------
// Clearance: keep a chain's stage marks off the desk cluster and off
// bystanders. #65 describes a toOpenFloor() desk-block nudge from "round 4"
// as already shipped and just missing the live-agent check — it isn't
// shipped anywhere, no branch, no commit. clearMarks() below is both checks
// built from scratch: desk cluster AND live agents in the same pass.
// ---------------------------------------------------------------------------

/** How close a stage mark is allowed to sit to another agent's current spot
 *  before that agent counts as an obstacle. Rough shoulder room, not a hard
 *  hitbox — this is a staging nudge, not physics. */
const AGENT_CLEARANCE = 0.7

/** Radius around each desk slot a stage mark has to clear. ZONES.desks.r
 *  (4.0) is the zone's LABEL RING — what the floor disc and zoneAt() use —
 *  not the furniture footprint; treating it as the obstacle would exclude
 *  most of the floor, not just the desk cluster. The slots (desk-tripo-
 *  12k.glb x6, see zones.js) are the actual cluster, so each slot is its
 *  own small obstacle instead. */
const DESK_CLEARANCE = 0.9

/** clearMarks() gives up nudging after this many pushes and accepts wherever
 *  it landed. A crowded floor (desk cluster plus a knot of idle agents) is a
 *  real state the demo can be in, not a bug to chase with an unbounded loop.
 *  8 left a realistic mid-cluster corner case one push short of fully
 *  clearing the six-slot desk block; 12 clears it with room to spare and
 *  this runs once per stage, not per frame, so the extra tries cost nothing
 *  worth measuring. */
const MAX_CLEAR_TRIES = 12

/** Margin on top of an obstacle's own radius so a cleared mark stops just
 *  outside it rather than exactly tangent, which still reads as touching. */
const CLEAR_MARGIN = 0.15

const _clearMid = new THREE.Vector3()
const _clearAxis = new THREE.Vector3()
const _clearPush = new THREE.Vector3()

/** The worst (largest-overlap) obstacle the pair's disc at `mid` is
 *  currently inside, or null if it's clear of all of them. Picking the
 *  worst rather than the nearest means each push in clearMarks's loop makes
 *  real progress instead of ping-ponging between two mild overlaps. */
function worstOverlap(mid, half, obstacles, margin) {
  let worst = null
  for (const o of obstacles) {
    const need = o.r + half + margin
    const overlap = need - Math.hypot(mid.x - o.x, mid.z - o.z)
    if (overlap > 0 && (!worst || overlap > worst.overlap)) worst = { x: o.x, z: o.z, overlap }
  }
  return worst
}

/**
 * Push a pair's stage marks (as returned by one of STAGE_MARKS's functions)
 * clear of `obstacles`, displacing the pair as a RIGID UNIT: the midpoint
 * slides, `marks.spacing` and each mark's facing do not change. Moving one
 * mark on its own would desync it from the other — every *Marks() helper
 * (highfiveMarks etc.) derives both spacing and facing from the same
 * midpoint/axis pair, so this only ever translates that pair, never rotates
 * or restretches it.
 *
 * `obstacles` is a flat list of circles: `{x, z, r}`. Caller decides what's
 * in it — the desk cluster, other agents, both.
 *
 * Mutates and returns `marks`, so callers can chain off STAGE_MARKS[kind]()
 * directly: `clearMarks(STAGE_MARKS[k](pa, pb, h), obstacles)`.
 */
export function clearMarks(marks, obstacles, opts = {}) {
  // No early return on an empty obstacle list: the BOUNDS clamp below is
  // part of this fix too (#startChain never clamped before), and marks can
  // land outside BOUNDS with zero obstacles in play just as easily as with
  // some.
  obstacles = obstacles || []
  const margin = opts.margin ?? CLEAR_MARGIN
  const maxTries = opts.maxTries ?? MAX_CLEAR_TRIES
  const half = marks.spacing * 0.5

  _clearAxis.subVectors(marks.b.pos, marks.a.pos)
  _clearAxis.y = 0
  // Degenerate spacing shouldn't happen (every *Marks() enforces a floor on
  // it) but a zero axis here would make the exactly-on-midpoint fallback
  // below point nowhere in particular rather than merely go unused.
  if (_clearAxis.lengthSq() < 1e-8) _clearAxis.set(0, 0, 1)
  _clearAxis.normalize()

  _clearMid.addVectors(marks.a.pos, marks.b.pos).multiplyScalar(0.5)

  // The escape direction is picked ONCE, off whichever obstacle is worst
  // first, then held fixed for the rest of this call — only the push
  // DISTANCE is recomputed each try, from whatever's worst now. Two
  // obstacles facing each other closer than 2x the clearance (the desk
  // cluster's own aisle is exactly this: two rows of slots close enough
  // that clearing one lands inside the other) turn "always push away from
  // the current worst obstacle" into a dead sandwich — clearing one side's
  // boundary lands squarely inside the other's, so recomputing the
  // direction aims the very next push squarely back where it came from.
  // Committing to one heading and walking further along it instead clears
  // both sides in a handful of steps.
  let heading = null
  for (let tries = 0; tries < maxTries; tries++) {
    const worst = worstOverlap(_clearMid, half, obstacles, margin)
    if (!worst) break
    if (!heading) {
      _clearPush.set(_clearMid.x - worst.x, 0, _clearMid.z - worst.z)
      // Obstacle sits exactly on the midpoint: no direction is "away" from
      // it, but the choice still has to be deterministic — same input,
      // same output, not whichever way float noise happens to lean. Off
      // to the side of the pair's own line (perpendicular to the a-b
      // axis) clears the obstacle without pushing either mark through the
      // other.
      if (_clearPush.lengthSq() < 1e-8) _clearPush.set(-_clearAxis.z, 0, _clearAxis.x)
      _clearPush.normalize()
      heading = _clearPush.clone()
    }
    _clearMid.addScaledVector(heading, worst.overlap + 1e-4)
  }

  // #startChain never clamped its marks, so a stage that lands near a wall
  // could already put a character outside BOUNDS before this fix — that's
  // the bug, and clamping the raw midpoint wouldn't fix it: a mark sits
  // `half` further out than the midpoint along the pair's own axis, so the
  // midpoint could pass Z.clampToFloor with a mark still past the wall.
  // Inset the clamp first, THEN run it through Z.clampToFloor, so both
  // marks land inside BOUNDS whatever the axis. The inset is the mark's
  // actual per-axis offset (|axis.x|*half, |axis.z|*half), not `half` on
  // both — a pair squared up along one axis has zero offset on the other
  // and shouldn't get pulled in off a wall it was never going to touch.
  const insetX = Math.min(Math.abs(_clearAxis.x) * half, (Z.BOUNDS.maxX - Z.BOUNDS.minX) / 2)
  const insetZ = Math.min(Math.abs(_clearAxis.z) * half, (Z.BOUNDS.maxZ - Z.BOUNDS.minZ) / 2)
  const midX = Math.max(Z.BOUNDS.minX + insetX, Math.min(Z.BOUNDS.maxX - insetX, _clearMid.x))
  const midZ = Math.max(Z.BOUNDS.minZ + insetZ, Math.min(Z.BOUNDS.maxZ - insetZ, _clearMid.z))
  const [cx, cz] = Z.clampToFloor(midX, midZ)
  marks.a.pos.set(cx - _clearAxis.x * half, 0, cz - _clearAxis.z * half)
  marks.b.pos.set(cx + _clearAxis.x * half, 0, cz + _clearAxis.z * half)
  return marks
}

/**
 * kind -> (a, b) -> stage list. Each stage is
 *   { kind, clipName: string|null, holdSec: number|null, start(): void }
 * `clipName` set means the stage ends on that clip's own length (like a
 * plain encounter); `clipName` null means it ends after `holdSec` instead
 * (the clash standoff and the notice pause have no natural end of their
 * own — a real rung-3 collision loops until resolveContest() says so, but
 * a replay isn't live, so a timed window standing in for "however long the
 * standoff read" is deliberate here, ~1.5-2s per the brief).
 */
const REPLAY_CHAINS = {
  // Rung 3, decision "wait": the standoff, then the requester agrees to
  // hold off — no animosity, so it resolves into a handshake.
  wait: (a, b) => [
    { kind: 'clash', clipName: null, holdSec: 1.75,
      start: () => { a.act('arguing'); b.act('reacting') } },
    { kind: 'handshake', clipName: 'handshake', holdSec: null,
      start: () => { a.act('handshaking'); b.act('handshaking') } },
  ],
  // Rung 3, decision "abort": the same standoff, but `b` (who prevails)
  // shoves `a` (who stood down) out of the way. The act assignment is the
  // deliberate mirror of shove()'s own a=winner convention — see replay()'s
  // doc comment.
  abort: (a, b) => [
    { kind: 'clash', clipName: null, holdSec: 1.75,
      start: () => { a.act('arguing'); b.act('reacting') } },
    { kind: 'shove', clipName: 'shove', holdSec: null,
      start: () => { b.act('shoving'); a.act('shoveReacting') } },
  ],
  // Rung 2: no real clash to stage first — highfive() already IS "a brief
  // mutual approach, then contact" via its own approach/settle phases. One
  // stage is the whole beat.
  share: (a, b) => [
    { kind: 'highfive', clipName: 'highfive', holdSec: null,
      start: () => { a.act('highfiving'); b.act('highfiving') } },
  ],
  // Rung 1: a short held beat of both just having arrived and noticing each
  // other, before the reader (a) steps back.
  'read-yield': (a, b) => [
    { kind: 'notice', clipName: null, holdSec: 0.5, start: () => {} },
    { kind: 'yield', clipName: 'yieldStep', holdSec: null,
      start: () => { a.act('yielding'); b.act('keeping') } },
  ],
  // Rung 4: same shape as read-yield — a beat of "...wait, is that the same
  // change?" before the doubletake.
  redundant: (a, b) => [
    { kind: 'notice', clipName: null, holdSec: 0.5, start: () => {} },
    { kind: 'doubletake', clipName: 'doubletake', holdSec: null,
      start: () => { a.act('doubletaking'); b.act('doubletaking') } },
  ],
}

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
   * Rung-2 collaboration beat, alternate take to highfive() — same contract,
   * same (a, b) signature, same "both play the SAME clip, facing each other
   * is already the mirror" trick. See clips/chestbump.js.
   */
  chestbump(a, b) {
    if (!a || !b || a === b || a.busy || b.busy) return null
    const height = (a.height + b.height) / 2
    const marks = chestbumpMarks(
      new THREE.Vector3(a.pos.x, 0, a.pos.z),
      new THREE.Vector3(b.pos.x, 0, b.pos.z),
      chestbumpSpacingFor(height))
    const ax = marks.a.pos.x, az = marks.a.pos.z
    const bx = marks.b.pos.x, bz = marks.b.pos.z

    a.busy = b.busy = true
    a.lastGreet = b.lastGreet = this.time
    a.goTo(ax, az, { yaw: yawToward(ax, az, bx, bz), label: 'meeting ' + b.name })
    b.goTo(bx, bz, { yaw: yawToward(bx, bz, ax, az), label: 'meeting ' + a.name })

    const e = { a, b, kind: 'chestbump', phase: 'approach', t: 0, marks: { a:[ax, az], b:[bx, bz] } }
    this.encounters.push(e)
    return e
  }

  /**
   * Rung-2 collaboration beat, understated alternate to highfive()/
   * chestbump(). Same contract. See clips/fistbump.js.
   */
  fistbump(a, b) {
    if (!a || !b || a === b || a.busy || b.busy) return null
    const height = (a.height + b.height) / 2
    const marks = fistbumpMarks(
      new THREE.Vector3(a.pos.x, 0, a.pos.z),
      new THREE.Vector3(b.pos.x, 0, b.pos.z),
      fistbumpSpacingFor(height))
    const ax = marks.a.pos.x, az = marks.a.pos.z
    const bx = marks.b.pos.x, bz = marks.b.pos.z

    a.busy = b.busy = true
    a.lastGreet = b.lastGreet = this.time
    a.goTo(ax, az, { yaw: yawToward(ax, az, bx, bz), label: 'meeting ' + b.name })
    b.goTo(bx, bz, { yaw: yawToward(bx, bz, ax, az), label: 'meeting ' + a.name })

    const e = { a, b, kind: 'fistbump', phase: 'approach', t: 0, marks: { a:[ax, az], b:[bx, bz] } }
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
   * The rung-3 "abort" beat, alternate to shove(): `a` still always wins,
   * same convention, but spends nothing on it — a slow, barely-turned
   * back-of-hand wave instead of a push. No contact, all contempt. See
   * clips/waveoff.js.
   */
  waveoff(a, b) {
    if (!a || !b || a === b || a.busy || b.busy) return null
    const height = (a.height + b.height) / 2
    const marks = waveoffMarks(
      new THREE.Vector3(a.pos.x, 0, a.pos.z),
      new THREE.Vector3(b.pos.x, 0, b.pos.z),
      waveoffSpacingFor(height))
    const ax = marks.a.pos.x, az = marks.a.pos.z
    const bx = marks.b.pos.x, bz = marks.b.pos.z

    a.busy = b.busy = true
    a.goTo(ax, az, { yaw: yawToward(ax, az, bx, bz), label: 'waving off ' + b.name })
    b.goTo(bx, bz, { yaw: yawToward(bx, bz, ax, az), label: 'waved off by ' + a.name })

    const e = { a, b, kind: 'waveoff', phase: 'approach', t: 0, marks: { a:[ax, az], b:[bx, bz] } }
    this.encounters.push(e)
    return e
  }

  /**
   * The rung-3 "abort" beat, alternate to shove(): `a` still always wins,
   * same convention, but this one is the cartoon version — big wind-up,
   * fast contact. See clips/slap.js.
   */
  slap(a, b) {
    if (!a || !b || a === b || a.busy || b.busy) return null
    const height = (a.height + b.height) / 2
    const marks = slapMarks(
      new THREE.Vector3(a.pos.x, 0, a.pos.z),
      new THREE.Vector3(b.pos.x, 0, b.pos.z),
      slapSpacingFor(height))
    const ax = marks.a.pos.x, az = marks.a.pos.z
    const bx = marks.b.pos.x, bz = marks.b.pos.z

    a.busy = b.busy = true
    a.goTo(ax, az, { yaw: yawToward(ax, az, bx, bz), label: 'settling it with ' + b.name })
    b.goTo(bx, bz, { yaw: yawToward(bx, bz, ax, az), label: 'slapped by ' + a.name })

    const e = { a, b, kind: 'slap', phase: 'approach', t: 0, marks: { a:[ax, az], b:[bx, bz] } }
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

  /**
   * The reel's "two-act" playback: the clash, THEN the beat that actually
   * resolved it — per the feature brief, replay is not supposed to jump
   * straight to the resolution. Chains multiple stages through the SAME
   * approach -> settle -> active phase machine every other paired action
   * already runs on (see #step) rather than inventing a second one: each
   * stage just re-settles the pair onto its own marks and plays its own
   * act(s), then either advances to the next stage or ends exactly like a
   * plain encounter does.
   *
   * `a`/`b` follow the reel's own convention throughout (see reel.d.ts /
   * live.js's toReelEvent) — `a` is the one who stands down, `b` is the one
   * who prevails — NOT shove()'s standalone convention where the first
   * argument always wins. `kind` is a resolution kind straight off a reel
   * event (`wait` | `abort` | `share` | `read-yield` | `redundant`).
   *
   * Returns the encounter (so the caller can, e.g., frame a camera on it
   * and watch for `phase === 'done'`), or null if either side is busy, the
   * pair is degenerate, or `kind` has no chain.
   */
  replay(a, b, kind) {
    if (!a || !b || a === b || a.busy || b.busy) return null
    const build = REPLAY_CHAINS[kind]
    if (!build) return null
    return this.#startChain(a, b, build(a, b))
  }

  /** Desk cluster plus every OTHER live agent, as circles clearMarks() can
   *  push stage marks off. Built fresh at each call site — a bystander who
   *  walked up (or wandered off) since the chain started is picked up next
   *  time this runs, not baked in at #startChain and stale by #advanceChain. */
  #clearanceObstacles(a, b) {
    const obstacles = Z.ZONES.desks.slots.map(([x, z]) => ({ x, z, r: DESK_CLEARANCE }))
    for (const other of this.agents) {
      if (other === a || other === b) continue
      obstacles.push({ x: other.pos.x, z: other.pos.z, r: AGENT_CLEARANCE })
    }
    return obstacles
  }

  #startChain(a, b, stages) {
    const [stage, ...rest] = stages
    const height = (a.height + b.height) / 2
    // Anchor is the pair's geometry at the moment the chain opens — every
    // *Marks() helper only ever reads aPos/bPos to derive a midpoint and
    // axis, so caching these two vectors is enough. #advanceChain reuses
    // them for every later stage instead of re-reading e.a.pos/e.b.pos,
    // which is what let position error compound stage over stage (#78).
    const anchor = {
      a: new THREE.Vector3(a.pos.x, 0, a.pos.z),
      b: new THREE.Vector3(b.pos.x, 0, b.pos.z),
    }
    const marks = clearMarks(
      STAGE_MARKS[stage.kind](anchor.a, anchor.b, height),
      this.#clearanceObstacles(a, b))
    const ax = marks.a.pos.x, az = marks.a.pos.z
    const bx = marks.b.pos.x, bz = marks.b.pos.z

    a.busy = b.busy = true
    a.lastGreet = b.lastGreet = this.time
    a.goTo(ax, az, { yaw: yawToward(ax, az, bx, bz), label: 'replaying with ' + b.name })
    b.goTo(bx, bz, { yaw: yawToward(bx, bz, ax, az), label: 'replaying with ' + a.name })

    const e = {
      a, b, kind: stage.kind, phase: 'approach', t: 0,
      marks: { a: [ax, az], b: [bx, bz] },
      isChain: true, stage, chain: rest, anchor,
    }
    this.encounters.push(e)
    return e
  }

  /** Advance a chained encounter to its next stage in place — no new
   *  approach, just a quick re-settle onto the next stage's own marks
   *  (reusing the 'settle' tween below), because the pair is already
   *  standing close together from the stage that just finished. */
  #advanceChain(e) {
    const [stage, ...rest] = e.chain
    e.stage = stage
    e.kind = stage.kind
    e.chain = rest
    const height = (e.a.height + e.b.height) / 2
    // Marks come from the anchor captured once at #startChain, not the
    // pair's live post-settle positions — that's what kept small per-stage
    // position error from compounding across the chain (#78). Clearance
    // still runs fresh per stage: a bystander can walk into the spot
    // mid-chain, and that's a per-stage concern, not part of the anchor.
    const marks = clearMarks(
      STAGE_MARKS[stage.kind](e.anchor.a, e.anchor.b, height),
      this.#clearanceObstacles(e.a, e.b))
    e.marks = { a: [marks.a.pos.x, marks.a.pos.z], b: [marks.b.pos.x, marks.b.pos.z] }
    e.from = { a: [e.a.pos.x, e.a.pos.z], b: [e.b.pos.x, e.b.pos.z] }
    e.phase = 'settle'
    e.t = 0
  }

  #step(e, dt) {
    const { a, b } = e
    e.t += dt
    if (e.phase === 'approach') {
      if (e.t > 14) {                                    // never hang forever
        // Silent on the happy path elsewhere — but a pair stuck here never
        // reached their marks, and that looks identical to a clean replay
        // once #end clears busy. Say so.
        console.warn(`replay approach timeout: ${e.a.name} + ${e.b.name} (${e.kind})`)
        return this.#end(e)
      }
      // Each agent's own #settle (see agent.js) now irons out the arrival
      // tolerance onto the exact mark and yaw, so there is nothing left for
      // this phase to correct — just wait for both to actually be done
      // moving (`moving` covers the settle glide, not just the walk) before
      // starting the paired clip.
      if (!a.moving && !b.moving && !a._turn && !b._turn && !a.seated && !b.seated) {
        e.phase = 'active'; e.t = 0
        this.#beginActive(e)
      }
    } else if (e.phase === 'settle') {
      // Only #advanceChain ever puts an encounter back into this phase — a
      // chain stage's own marks differ from the previous stage's (different
      // spacing, different facing), so re-settling here is a real in-place
      // reposition, not the arrival-tolerance touch-up the 'approach' branch
      // above used to do before agent.js grew its own #settle.
      const k = Math.min(1, e.t / 0.28)
      const s = k * k * (3 - 2 * k)
      for (const key of ['a', 'b']) {
        const ag = e[key], f = e.from[key], m = e.marks[key]
        ag.pos.x = f[0] + (m[0] - f[0]) * s
        ag.pos.z = f[1] + (m[1] - f[1]) * s
      }
      if (k >= 1) {
        e.phase = 'active'; e.t = 0
        e.stage.start()
      }
    } else if (e.phase === 'active') {
      if (e.isChain) {
        // A stage with a clipName ends on its own clip's length, same as
        // the plain encounters below; a stage without one (the argue-like
        // clash, or the rung-1/4 "notice" beat) has no natural end and
        // holds for its own timed window instead. Either way, once the
        // current stage is done there's either another stage to re-settle
        // onto (#advanceChain) or the whole replay ends like any encounter.
        const stage = e.stage
        const done = stage.clipName
          ? e.t >= ANIM.getClip(stage.clipName).duration + 0.2
          : e.t >= stage.holdSec
        if (done) {
          if (e.chain.length) this.#advanceChain(e)
          else return this.#end(e)
        }
        return
      }
      // A contest has no clip-length end: it lasts until resolveContest()
      // says the region is free. Everything else (highfive, handshake,
      // shove, yield, doubletake, chestbump, fistbump, waveoff, slap) plays
      // out once and ends on its own clip's length.
      const CLIP_OF_KIND = {
        highfive: 'highfive', handshake: 'handshake', shove: 'shove',
        yield: 'yieldStep', doubletake: 'doubletake',
        chestbump: 'chestbump', fistbump: 'fistbump',
        waveoff: 'waveoff', slap: 'slap',
      }
      const clipName = CLIP_OF_KIND[e.kind]
      if (clipName && e.t >= ANIM.getClip(clipName).duration + 0.2) {
        return this.#end(e)
      }
    }
  }

  /** Fires the paired clip the instant a pair is exactly on its marks —
   *  called from 'approach' once both sides finish steering AND settling,
   *  and from 'settle' once a chain's in-place reposition finishes. Split
   *  out of #step so both entry points share one dispatch instead of
   *  duplicating the kind/stage branching. */
  #beginActive(e) {
    const { a, b } = e
    if (e.isChain) {
      // A replay() stage owns its own act() calls (see REPLAY_CHAINS) — the
      // role a given side plays (winner/loser, reader/editor) can differ
      // from what the same kind means standalone, so this does not fall
      // through to the kind-based dispatch below.
      e.stage.start()
    } else if (e.kind === 'contest') {
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
    } else if (e.kind === 'waveoff') {
      // Same abort-family shape as shove — `a` always wins — different
      // beat; see clips/waveoff.js.
      a.act('wavingOff')
      b.act('waveoffReacting')
    } else if (e.kind === 'slap') {
      // Same abort-family shape as shove — `a` always wins — different
      // beat; see clips/slap.js.
      a.act('slapping')
      b.act('slapReacting')
    } else if (e.kind === 'yield') {
      // Asymmetric like shove — reader and editor play different clips —
      // but neither one "wins"; see clips/yield.js.
      a.act('yielding')
      b.act('keeping')
    } else {
      // highfive, handshake, doubletake, chestbump, fistbump: same frame,
      // same fade, both from time zero, both the SAME clip — facing each
      // other is already the mirror. That is the whole sync story; see
      // highfive.js.
      const sameClipAct = {
        handshake: 'handshaking', doubletake: 'doubletaking',
        chestbump: 'chestbumping', fistbump: 'fistbumping',
      }[e.kind] || 'highfiving'
      a.act(sameClipAct)
      b.act(sameClipAct)
    }
  }

  #end(e) {
    e.phase = 'done'
    e.a.busy = e.b.busy = false
    e.a.lastGreet = e.b.lastGreet = this.time
    // _move, not `moving`: a settle is a glide onto a mark, and swapping the
    // clip under it is fine. A walk is not — that agent has somewhere to be,
    // and #end never runs again to retry.
    if (!e.a._move && e.a.activity !== 'idle') e.a.act('idle')
    if (!e.b._move && e.b.activity !== 'idle') e.b.act('idle')
  }
}

/** Yaw that makes a character at (fx,fz) face (tx,tz), external convention. */
export function yawToward(fx, fz, tx, tz) {
  return Math.atan2(-(tx - fx), -(tz - fz))
}
