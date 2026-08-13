// Generated fallback history for the highlight reel, so the panel is never
// empty on a fresh checkout. Every event here is source:'generated' — never
// let one of these pass as a real relay decision, per the brief.
//
// office.html imports this and merges it with reel.js's own SAMPLE_EVENTS
// (`new ReelStore([...SAMPLE_EVENTS, ...seedEvents()])`) — this file's
// original "not imported anywhere yet" header was true for exactly one
// round; it's wired in now, so the count and spread below are sized for
// what the reel actually needs to exercise (paging, the empty state, an
// uneven human/rung spread), not just "parse and be honest."
//
// Deterministic given the same `now`: a fixed-seed PRNG (mulberry32, no
// Math.random anywhere below) picks the cast, rung, path and resolution
// detail for each slot, and `now` only offsets timestamps into the past.
// Same input, same output, every time — that's what makes office-seed.test.ts
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
// 75 puts the combined reel (this + reel.js's 12 SAMPLE_EVENTS) comfortably
// past REVEAL_STEP (40 in reel.js), so "show older" and the tail of the
// list are actually reachable on a fresh checkout instead of only in a
// long-running one. See office-reel.test.ts for the paging math itself —
// this file only has to produce enough rows.
const COUNT = 75

function pick(rng, arr) { return arr[Math.floor(rng() * arr.length)] }

function pair(rng) {
  const ai = Math.floor(rng() * CAST.length)
  let bi = Math.floor(rng() * (CAST.length - 1))
  if (bi >= ai) bi++
  return [{ ...CAST[ai] }, { ...CAST[bi] }]
}

// One human (sara, the only human with a single agent — agent-4) is kept
// off rung 4 entirely, on purpose: the brief asks for at least one
// human×rung combination that's provably empty, so "filter to a human and
// a rung with nothing in it" is always reachable without hoping the RNG
// happens to land that way. reel.js's own SAMPLE_EVENTS already agrees by
// accident (neither of its two rung-4 rows involves sara) — this makes it
// a guarantee instead of a coincidence.
function pairExcludingHuman(rng, human, maxTries = 50) {
  for (let i = 0; i < maxTries; i++) {
    const [a, b] = pair(rng)
    if (a.human !== human && b.human !== human) return [a, b]
  }
  // Statistically unreachable with 5 cast members and 50 tries (each try
  // has better than even odds of avoiding one human), but a deterministic
  // fallback beats a flaky one.
  const eligible = CAST.filter(c => c.human !== human)
  return [{ ...eligible[0] }, { ...eligible[1] }]
}

// Rung weights, skewed toward the low end — "co-location and glance-past
// reads happen constantly, a genuinely contested symbol is rarer," per the
// collision ladder in the product brief. Sums to 1; see pickRung below.
const RUNG_WEIGHTS = [0.30, 0.24, 0.20, 0.16, 0.10]

function pickRung(rng) {
  const r = rng()
  let acc = 0
  for (let i = 0; i < RUNG_WEIGHTS.length; i++) {
    acc += RUNG_WEIGHTS[i]
    if (r < acc) return i
  }
  return RUNG_WEIGHTS.length - 1
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

// Timestamps deliberately staged into three bands rather than one flat
// random spread, so "minutes ago" and "days ago" both actually show up
// instead of being left to chance: a uniform draw over several days would
// only rarely land inside the last hour. Uneven on purpose — a quiet
// afternoon doesn't produce evenly-spaced collisions either.
function minutesAgoFor(i, rng) {
  if (i < 6) return Math.floor(rng() * 55) + i          // last hour
  if (i < 20) return Math.floor(rng() * 640) + 60        // next ~10h
  return Math.floor(rng() * 5460) + 700                  // out to ~4 days
}

/**
 * A generated history spread over minutes to several days, covering every
 * rung 0-4 but skewed toward the low ones, with rung 4 deliberately never
 * involving sara so a human×rung filter combo is always provably empty.
 * Resolutions are drawn from the same mapping the resolution clips use.
 *
 * @param {number} [now]
 * @returns {import('./live.d.ts').ReelEvent[]}
 */
export function seedEvents(now = Date.now()) {
  const rng = mulberry32(SEED)
  const events = []
  for (let i = 0; i < COUNT; i++) {
    const rung = pickRung(rng)
    const [a, b] = rung === 4 ? pairExcludingHuman(rng, 'sara') : pair(rng)
    const path = pick(rng, PATHS)
    // `+ i` keeps two events from ever landing on the exact same
    // timestamp, which would otherwise make "newest first" ambiguous for
    // no reason.
    const minutesAgo = minutesAgoFor(i, rng) + i
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
