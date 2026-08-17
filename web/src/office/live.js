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
 * frames. onDecision and onRedundant are the same idea for the frames that
 * carry *why* a conflict resolved — see isDecision/isRedundant below for
 * exactly what they demand before firing. Everything else on the wire is
 * still silently ignored: this scene has nothing to do with a lease table
 * beyond rendering these three kinds of frame.
 *
 * @param {{room:string, human:string, url?:string,
 *          onPresence?:(msg:object)=>void,
 *          onDecision?:(msg:object)=>void,
 *          onRedundant?:(msg:object)=>void,
 *          onOpen?:()=>void, onClose?:()=>void}} cfg
 * @returns {{close():void}}
 */
export function connect({ room, human, url = RELAY_URL, onPresence, onDecision, onRedundant, onOpen, onClose }) {
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
      // "negotiate" (a live contest, decided) and "claim_result" (a claim
      // refused outright) both carry the wait-die verdict — see
      // isDecision's own comment for the exact shape, and toReelEvent
      // below for what the reel does with it.
      else if (isDecision(msg) && onDecision) onDecision(msg)
      // "redundant_work" is rung 4's own frame: a granted claim that
      // turned out to duplicate somebody else's declared intent.
      else if (isRedundant(msg) && onRedundant) onRedundant(msg)
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

// Both "negotiate" (go/internal/relaysrv/relay.go's onEvent, ~line 703) and
// a refused "claim_result" (onClaim, ~line 815) carry the same wait-die
// verdict field: `decision`, "wait" or "abort", straight out of
// waitdie.go's resolveWaitDie. A *granted* claim_result has no `decision`
// at all, so this guard naturally excludes it without a separate check.
function isDecision(m) {
  return !!m && typeof m === 'object' &&
    (m.type === 'negotiate' || m.type === 'claim_result') &&
    (m.decision === 'wait' || m.decision === 'abort')
}

// redundant_work (relay.go's redundancyPayload) is rung 4's own frame:
// agent/human/intent identify who did the duplicate work, region.path is
// where, score is the similarity that tripped it.
function isRedundant(m) {
  return !!m && typeof m === 'object' && m.type === 'redundant_work' &&
    typeof m.agent === 'string' && typeof m.human === 'string' &&
    typeof m.intent === 'string' &&
    !!m.region && typeof m.region === 'object' && typeof m.region.path === 'string' &&
    typeof m.score === 'number'
}

let reelSeq = 0

/**
 * Normalize a decision or redundant-work frame into the highlight reel's
 * event shape (matches reel.js's mountReel and seed.js's seedEvents, so all
 * three agree without importing each other — office/*.js can't import
 * across modules that don't already know about one another's internals).
 *
 * One real gap, carried over from this file's header note about what the
 * wire actually contains: `negotiate` and `claim_result` are replies sent
 * only to the connection that triggered them, and neither carries that
 * connection's own agent/human (the relay assumes the recipient already
 * knows who it is), and `negotiate` carries no path either. Rather than
 * guess, those fields come back as '' — never a made-up name standing in
 * for a real one. redundant_work has no such hole; both sides are on the
 * frame.
 *
 * @param {object} frame
 * @param {number} [now]
 * @param {{agent:string, human:string}|null} [requester] the requester's own
 *   identity, when known — see LiveDirector.resolutionFor below, which is
 *   how a caller with an active tracked contest pair can fill this in. Left
 *   out (or null), `a` stays blank exactly as before: this parameter only
 *   ever *adds* an identity the caller has separately confirmed, it never
 *   changes how the frame itself is read.
 * @returns {object|null} a reel event, or null if the frame isn't one of
 *   the three kinds this function knows how to normalize
 */
export function toReelEvent(frame, now = Date.now(), requester = null) {
  if (!frame || typeof frame !== 'object') return null
  const id = `live-${now}-${reelSeq++}`

  if (frame.type === 'negotiate' || frame.type === 'claim_result') {
    if (frame.decision !== 'wait' && frame.decision !== 'abort') return null
    // claim_result never carries a rung — a refused claim is rung 3 by
    // definition (relay.go's own comment on onClaim). negotiate does
    // carry one; trust it when present, fall back to 3 otherwise.
    const rung = typeof frame.rung === 'number' ? frame.rung : 3
    const holderAgent = typeof frame.holder_agent === 'string' ? frame.holder_agent
      : typeof frame.held_by === 'string' ? frame.held_by : ''
    const holderHuman = typeof frame.holder_human === 'string' ? frame.holder_human
      : typeof frame.human === 'string' ? frame.human : ''
    const path = !!frame.region && typeof frame.region === 'object' && typeof frame.region.path === 'string'
      ? frame.region.path : ''
    const detail = typeof frame.holder_priority === 'string'
      ? `holder priority ${frame.holder_priority}` : undefined
    const a = requester && typeof requester.agent === 'string' && requester.agent
      ? { agent: requester.agent, human: typeof requester.human === 'string' ? requester.human : '' }
      : { agent: '', human: '' }
    return {
      id, ts: now, rung,
      a,
      b: { agent: holderAgent, human: holderHuman },
      path,
      resolution: { kind: frame.decision === 'wait' ? 'wait' : 'abort', detail },
      source: 'live',
    }
  }

  if (frame.type === 'redundant_work') {
    if (typeof frame.agent !== 'string' || typeof frame.human !== 'string') return null
    const path = !!frame.region && typeof frame.region === 'object' && typeof frame.region.path === 'string'
      ? frame.region.path : ''
    const detail = typeof frame.score === 'number' ? `score ${frame.score}` : undefined
    return {
      id, ts: now, rung: 4,
      a: { agent: frame.agent, human: frame.human },
      b: { agent: '', human: '' },
      path,
      resolution: { kind: 'redundant', detail },
      source: 'live',
    }
  }

  return null
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

// #60's other open question, settled this round: should a live decision
// play one of the abort-family variants (shove/waveoff/slap) the way a
// reel replay already can, or should live stay literal (always shove)?
//
// The call: give live the same variety. A live "abort" and a replayed one
// are the same underlying event — the only difference is *when* you're
// watching it, not what happened — so there's no honesty reason for live
// to be flatter than its own highlight later. The literal-live argument
// (live = "the actual event", replay = "a highlight reel take on it") only
// holds up if the variant were somehow fictional, and it isn't: waveoff
// and slap are exactly as much "what happened" as shove is, just a
// different flavor of the same wait-die abort. So: wired, not documented-
// as-a-non-fix.
//
// 'wait' has no variant family to pick from — REPLAY_CHAINS' own 'wait'
// chain only ever ends in handshake (see agent.js), so there is nothing
// to vary there; this only ever returns non-null for 'abort'.
//
// Deterministic on the pair, not the frame: the same two agent ids
// clashing again should read as "them, doing their thing again", not a
// coin flip every time, the same reasoning office.html's own
// pickReplayVariant applies per event id. No event id exists at this
// layer (a raw decision frame, not a reel row), so the pair's own ids are
// the next best stable key.
export const LIVE_ABORT_VARIANTS = ['shove', 'waveoff', 'slap']

function hashPair(s) {
  let h = 2166136261
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619) }
  return h >>> 0
}

/**
 * Which World method a live "abort" decision should play. Pure and
 * world-agnostic on purpose — office.html is the one place that knows
 * whether `world[variant]` actually exists this session (clip landing
 * order isn't guaranteed), so it still needs its own
 * `typeof world[variant] === 'function'` guard with `shove` as the
 * fallback, same shape as pickReplayVariant's own family-availability
 * check. This function only ever answers "which name", never calls
 * anything.
 *
 * @param {'wait'|'abort'} kind
 * @param {string} winnerId
 * @param {string} loserId
 * @returns {string|null} an ABORT_VARIANTS member for 'abort', null for
 *   'wait' (no family to pick from) or anything else
 */
export function pickLiveVariant(kind, winnerId, loserId) {
  if (kind !== 'abort') return null
  const i = hashPair(`${winnerId}:${loserId}`) % LIVE_ABORT_VARIANTS.length
  return LIVE_ABORT_VARIANTS[i]
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
    this.records = new Map()      // agent id -> { human, verb, path, zone, rung, lastSeen }
    this.contests = new Map()     // agent id -> partner agent id, both directions
    // agent id -> the shared { path, aId, bId } record for the contest it's
    // currently in, both directions (same object under both keys, so a
    // lookup from either side sees the same pair) — this is #60's client
    // side bookkeeping: the wire never tells us who "self" is on a decision
    // frame, so we remember our own active pairs and match decisions back
    // to them instead. See resolutionFor().
    this.contestPairs = new Map()
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

  /** The human for a live agent id, or '' if we've never seen a presence
   *  frame for it. Used to fill in a decision-matched requester's name
   *  alongside their agent id — see resolutionFor()'s caller in office.html. */
  humanOf(id) {
    const rec = this.records.get(id)
    return rec ? rec.human : ''
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

  markContest(a, b) {
    this.contests.set(a, b); this.contests.set(b, a)
    // Path comes off whichever side we already have a presence record for
    // (should be both, since a contest is only ever marked between two live
    // agents onPresence just saw) — never guessed, left '' if somehow both
    // are missing.
    const path = this.records.get(a)?.path || this.records.get(b)?.path || ''
    const pair = { path, aId: a, bId: b }
    this.contestPairs.set(a, pair)
    this.contestPairs.set(b, pair)
  }

  /** Clear a contest this agent was part of, if any, and return the partner
   *  id so the caller can resolve the paired encounter. Both directions are
   *  cleared, so resolving from either side is safe and idempotent. The
   *  tracked pair (see markContest/resolutionFor) is cleared right alongside
   *  it — a stale pair must never outlive the contest it described, or a
   *  later unrelated decision frame could get matched to it by mistake. */
  clearContest(id) {
    const other = this.contests.get(id)
    if (other === undefined) return null
    this.contests.delete(id)
    this.contests.delete(other)
    this.contestPairs.delete(id)
    this.contestPairs.delete(other)
    return other
  }

  contestPartner(id) {
    const other = this.contests.get(id)
    return other === undefined ? null : other
  }

  /**
   * #60: match an incoming negotiate/claim_result decision frame back to one
   * of our own tracked contest pairs, without the relay ever telling us
   * which side is "self" — see this file's header note on why the wire
   * can't do that today, and the issue for the two options weighed there.
   * This is the client-side-bookkeeping option: we already know, from our
   * own markContest() calls, which two agent ids are contesting which path;
   * a decision frame that names one of those ids as the holder (or as who
   * the lease is handing over to) is presumed to be about that pair.
   *
   * Deliberately conservative: a frame that names nobody we're tracking, or
   * whose path contradicts the pair it would otherwise match, returns null
   * rather than a guess — never present a resolution as real when it isn't
   * traceable back to an identity we actually watched.
   *
   * @param {object} frame a negotiate or claim_result frame off the wire
   * @returns {{winnerId:string, loserId:string, kind:'wait'|'abort'}|null}
   */
  resolutionFor(frame) {
    if (!frame || typeof frame !== 'object') return null
    if (frame.type !== 'negotiate' && frame.type !== 'claim_result') return null
    if (frame.decision !== 'wait' && frame.decision !== 'abort') return null

    const holderAgent = typeof frame.holder_agent === 'string' ? frame.holder_agent
      : typeof frame.held_by === 'string' ? frame.held_by : ''
    const handoverTo = typeof frame.handover_to === 'string' ? frame.handover_to : ''
    const path = !!frame.region && typeof frame.region === 'object' && typeof frame.region.path === 'string'
      ? frame.region.path : ''

    const checked = new Set()
    for (const pair of this.contestPairs.values()) {
      if (checked.has(pair)) continue
      checked.add(pair)

      // holder_agent is who currently holds the lease — the natural
      // "winner" on both a wait (they keep it) and an abort (they keep it
      // and the requester's attempt dies). handover_to is the fallback for
      // a frame shaped around a handoff instead: whoever it's handing over
      // to is the one coming out ahead.
      let winnerId = ''
      if (holderAgent && (holderAgent === pair.aId || holderAgent === pair.bId)) winnerId = holderAgent
      else if (handoverTo && (handoverTo === pair.aId || handoverTo === pair.bId)) winnerId = handoverTo
      else continue

      // Identity matched one of our tracked ids — but if the frame also
      // names a path and it disagrees with the pair's, this is a different
      // contest wearing a familiar agent id (e.g. that agent already moved
      // on to a new file). Don't cross-wire it.
      if (path && pair.path && path !== pair.path) continue

      const loserId = winnerId === pair.aId ? pair.bId : pair.aId
      return { winnerId, loserId, kind: frame.decision }
    }
    return null
  }
}
