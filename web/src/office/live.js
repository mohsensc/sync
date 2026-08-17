// Live wiring for the office: the relay connection, and the pure bookkeeping
// that turns a presence frame into "where does this character stand, and is
// it in a fight with anybody".
//
// Kept apart from office.html for the same reason interact.js and demo.js
// are — the scene file stays a scene file. office.html owns the THREE side
// (character roots, meshes); LiveDirector below owns none of it, so it can
// be unit tested the way zones.js and characters.ts already are.
//
// office/*.js runs unbundled in the browser (see office.html's importmap),
// so it cannot import the web/src/*.ts side that main.ts and subscribe.ts
// use for the capsule viewer — there is no TS toolchain in this path. This
// file is that same subscribe.ts idea, re-hosted here in plain JS, reusing
// what main.ts already got right about the connection: open the socket, send
// one join frame, and never let a bad frame reach the caller.

import * as Z from './zones.js'

export const RELAY_URL = 'ws://127.0.0.1:8799'
// Matches python/src/agent_presence/leases.py's PRESENCE_TTL_S. A character
// that has gone this long without a presence frame reads as "not here", the
// same rule the capsule viewer's CharacterRegistry uses.
export const PRESENCE_TTL_MS = 30_000

/**
 * Open a websocket to the relay and join a room. Mirrors main.ts's
 * connection exactly — one join frame on open, JSON parsed defensively on
 * every message — so this is the second half of the same client, not a
 * different one.
 *
 * onOpen/onClose are for the caller's own connectivity UI (demo fallback,
 * a "live" badge); onPresence only ever fires for well-formed presence
 * frames, everything else on the wire is silently ignored because this
 * scene has nothing to do with a lease table.
 *
 * @param {{room:string, human:string, url?:string,
 *          onPresence:(msg:object)=>void,
 *          onOpen?:()=>void, onClose?:()=>void}} cfg
 * @returns {{close():void}}
 */
export function connect({ room, human, url = RELAY_URL, onPresence, onOpen, onClose }) {
  let ws
  try {
    ws = new WebSocket(url)
  } catch {
    if (onClose) onClose()
    return { close() {} }
  }

  ws.onopen = () => {
    ws.send(JSON.stringify({ type: 'join', room, agent: 'viewer', human }))
    if (onOpen) onOpen()
  }
  ws.onmessage = (e) => {
    try {
      const msg = JSON.parse(e.data)
      if (isPresence(msg) && onPresence) onPresence(msg)
      else if (isLeasesSnapshot(msg) && onPresence) {
        // The join reply. `presence` rides along on it now (see
        // relay.py's `_send_lease_snapshot`) so a room that's already
        // busy doesn't render empty until the next live event — feed each
        // entry through the same path a live frame takes, so a joiner
        // sees the room as it already is, not as it becomes from here.
        for (const entry of msg.presence) {
          const p = { type: 'presence', ...entry }
          if (isPresence(p)) onPresence(p)
        }
      }
    } catch {
      // A bad frame must never blank the world.
    }
  }
  // onerror carries nothing actionable of its own; onclose fires right after
  // it either way (a failed connect closes too), so onClose is the one place
  // the caller needs to react.
  ws.onerror = () => {}
  ws.onclose = () => { if (onClose) onClose() }

  return { close() { try { ws.close() } catch { /* already gone */ } } }
}

function isPresence(m) {
  return !!m && typeof m === 'object' && m.type === 'presence' &&
    typeof m.agent === 'string' && typeof m.human === 'string' &&
    typeof m.verb === 'string' &&
    !!m.region && typeof m.region === 'object' && typeof m.region.path === 'string'
}

/** region.start/region.end are optional on a presence frame — most verbs
 *  (read a whole file, run a command) have no line range at all. Pull them
 *  out defensively: both must be finite and end past start, or this reads
 *  as "no region", same as the field being absent. Never throws on a
 *  malformed frame; that's what the presence-frame guard above is for. */
export function regionFromMsg(msg) {
  const r = msg && msg.region
  if (!r) return null
  const start = r.start
  const end = r.end
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return null
  return { start, end }
}

function isLeasesSnapshot(m) {
  return !!m && typeof m === 'object' && m.type === 'leases' && Array.isArray(m.presence)
}

/** Six-colour hash, kept identical to web/src/palette.ts's hairFor by hand —
 *  same reason zones.js keeps its own copy of PALETTE instead of importing
 *  the .ts one: this file cannot import across the toolchain boundary. */
const HAIR = [
  Z.PALETTE.terracotta, Z.PALETTE.slate, Z.PALETTE.mustard,
  Z.PALETTE.mauve, Z.PALETTE.coffee, Z.PALETTE.salmon,
]

export function hairFor(human) {
  const s = String(human || '')
  let h = 0
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0
  return HAIR[h % HAIR.length]
}

/**
 * Turns presence frames into zone-routed positions, without touching a
 * single THREE object. office.html asks it "what changed", then does the
 * spawning, walking and pairing itself.
 */
export class LiveDirector {
  constructor({ ttlMs = PRESENCE_TTL_MS, zoneFor = Z.zoneFor } = {}) {
    this.ttlMs = ttlMs
    this.zoneFor = zoneFor
    this.records = new Map()    // agent id -> { human, verb, path, zone, rung, lastSeen }
    this.contests = new Map()   // agent id -> partner agent id, both directions
  }

  /**
   * Fold one presence frame in. Returns everything office.html needs to act
   * on it:
   *   spawned     — true the first time this agent id is seen
   *   zone        — where the character should be headed
   *   contestWith — another live agent id sharing this exact path at rung 3
   *                 or higher (the contested-write beat), or null
   *   shareWith   — another live agent id to stand beside instead of taking
   *                 a fresh slot: same human (cluster by human) or same path
   *                 (rung 0 co-location), whichever is found first
   */
  onPresence(msg, now = Date.now()) {
    const id = msg.agent
    const human = msg.human
    const verb = msg.verb
    const path = msg.region.path
    const rung = typeof msg.rung === 'number' ? msg.rung : 0
    const zone = this.zoneFor(verb, path)
    const spawned = !this.records.has(id)
    const region = regionFromMsg(msg)

    this.records.set(id, { human, verb, path, zone, rung, lastSeen: now, region })

    let contestWith = null
    if (rung >= 3) {
      for (const [otherId, rec] of this.records) {
        if (otherId === id || this.#stale(rec, now)) continue
        if (rec.path === path) { contestWith = otherId; break }
      }
    }

    let shareWith = null
    if (!contestWith) {
      for (const [otherId, rec] of this.records) {
        if (otherId === id || this.#stale(rec, now)) continue
        if (rec.zone !== zone) continue
        if (rec.human === human || rec.path === path) { shareWith = otherId; break }
      }
    }

    return {
      id, human, verb, path, zone, rung, spawned, contestWith, shareWith,
      // Absent (null) means whole-file, today's behaviour, unchanged — a
      // consumer that never reads these two fields sees no difference at
      // all. office.html's onLivePresence forwards these onto
      // `a.gitStart`/`a.gitEnd` right after `.path`.
      start: region ? region.start : null,
      end: region ? region.end : null,
    }
  }

  #stale(rec, now) { return now - rec.lastSeen > this.ttlMs }

  /** Agent ids that have gone quiet past the TTL. Deletes them from the
   *  director's own bookkeeping too — the caller still owns despawning the
   *  THREE side and resolving any contest via clearContest(). */
  expire(now = Date.now()) {
    const gone = []
    for (const [id, rec] of this.records) {
      if (this.#stale(rec, now)) { this.records.delete(id); gone.push(id) }
    }
    return gone
  }

  has(id) { return this.records.has(id) }

  markContest(a, b) { this.contests.set(a, b); this.contests.set(b, a) }

  /** Clear a contest this agent was part of, if any, and return the partner
   *  id so the caller can resolve the paired encounter. Both directions are
   *  cleared, so resolving from either side is safe and idempotent. */
  clearContest(id) {
    const other = this.contests.get(id)
    if (other === undefined) return null
    this.contests.delete(id)
    this.contests.delete(other)
    return other
  }

  contestPartner(id) {
    const other = this.contests.get(id)
    return other === undefined ? null : other
  }
}
