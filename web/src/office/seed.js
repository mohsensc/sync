// Generated fallback history for the highlight reel, so the panel is never
// empty on a fresh checkout. Every event here is source:'generated' — never
// let one of these pass as a real relay decision, per the brief.
//
// Not imported anywhere yet — reel integration is next round's wiring, per
// this round's plan. This file only has to exist, parse, and be honest
// about its own output.
//
// Deterministic given the same `now`: a fixed-seed PRNG (mulberry32, no
// Math.random anywhere below) picks the cast, path and resolution detail
// for each slot, and `now` only offsets timestamps into the past. Same
// input, same output, every time — that's what makes office-seed.test.ts
// possible without faking the clock.

// Same five agents as office.html's AGENT_CAST, paired with human names
// already established by reel.js's SAMPLE_EVENTS, so a reel built from
// both sources reads as one consistent office, not two casts.
const CAST = [
  { agent: 'agent-1', human: 'priya' },
  { agent: 'agent-2', human: 'priya' },
  { agent: 'agent-3', human: 'dev' },
  { agent: 'agent-4', human: 'sara' },
  { agent: 'agent-5', human: 'dev' },
]

const PATHS = [
  'src/orders/total.ts', 'web/src/office/agent.js', 'go/internal/relaysrv/waitdie.go',
  'web/src/office/live.js', 'README.md', 'src/auth/session.ts', 'web/src/office/zones.js',
  'go/internal/relaysrv/relay.go', 'web/test/office-live.test.ts', 'package.json',
  'web/src/office/dressing.js', 'web/src/office/clips/argue.js', 'web/src/office/interact.js',
  'web/src/office/anim.js', 'go/internal/relaysrv/registry.go', 'web/src/palette.ts',
  'web/src/office/demo.js', 'web/src/office/highfive.js', 'go/internal/relaysrv/priority.go',
  'web/src/office/clips/handshake.js',
]

const ABORT_DETAILS = ['wait-die, younger aborted', 'priority tier win', 'wait-die, lower tier']
const WAIT_DETAILS = ['granted for now, other waits', 'handover queued']

/** Small deterministic PRNG. Same seed, same sequence, every run — that's
 *  the whole reason it's here instead of Math.random. */
function mulberry32(seed) {
  let a = seed
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const SEED = 0xC0FFEE
const COUNT = 25

function pick(rng, arr) { return arr[Math.floor(rng() * arr.length)] }

function pair(rng) {
  const ai = Math.floor(rng() * CAST.length)
  let bi = Math.floor(rng() * (CAST.length - 1))
  if (bi >= ai) bi++
  return [{ ...CAST[ai] }, { ...CAST[bi] }]
}

// The resolution mapping the resolution clips key off of — kept in sync by
// hand with STATE.md's rung table:
//   0 co-location        -> no resolution, nothing happened
//   1 read vs edit        -> reader yields
//   2 same file, disjoint -> they split it, no overlap
//   3 same symbol         -> wait-die: the more entitled transaction waits,
//                            the less entitled aborts
//   4 redundant work      -> caught by similarity, score included
function resolutionFor(rung, rng) {
  if (rung === 0) return null
  if (rung === 1) return { kind: 'read-yield' }
  if (rung === 2) return { kind: 'share' }
  if (rung === 4) {
    const score = Math.round((0.7 + rng() * 0.29) * 100) / 100
    return { kind: 'redundant', detail: `score ${score}` }
  }
  return rng() < 0.5
    ? { kind: 'wait', detail: pick(rng, WAIT_DETAILS) }
    : { kind: 'abort', detail: pick(rng, ABORT_DETAILS) }
}

/**
 * ~25 generated events spread over the past several hours, covering every
 * rung 0-4 at least a few times, resolutions drawn from the same mapping
 * the resolution clips use.
 *
 * @param {number} [now]
 * @returns {import('./live.d.ts').ReelEvent[]}
 */
export function seedEvents(now = Date.now()) {
  const rng = mulberry32(SEED)
  const events = []
  for (let i = 0; i < COUNT; i++) {
    const rung = i % 5
    const [a, b] = pair(rng)
    const path = pick(rng, PATHS)
    // Spread across the last ~6 hours. `+ i` keeps two events from ever
    // landing on the exact same timestamp, which would otherwise make
    // "newest first" ambiguous for no reason.
    const minutesAgo = Math.floor(rng() * 355) + i
    events.push({
      id: `seed-${i}`,
      ts: now - minutesAgo * 60_000,
      rung,
      a, b,
      path,
      resolution: resolutionFor(rung, rng),
      source: 'generated',
    })
  }
  return events
}
