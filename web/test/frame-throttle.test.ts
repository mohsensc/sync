import { describe, it, expect } from 'vitest'
import { makeAmbientThrottle } from '../src/office/frame-throttle.js'

// The shared mechanism behind every "slow breathing" ambient effect this
// round folded onto office.html's one frame loop (desk tint, hover pulse,
// churn glow, ghost sway). The property that actually matters — and the
// one a naive "just count frames and fire every Nth one" implementation
// gets wrong — is that the phase math downstream advances at real speed,
// not at (fire rate) x (fixed step). See gitsignals.js/interact.js/
// ghost.js's own tick(dt): each does `phase += elapsed * rate`, so if this
// handed back a fixed period instead of the real accumulated time, a
// dropped frame (dt briefly larger than usual) would make the breathing
// silently run in slow motion relative to the clock instead of just
// stepping less often.
describe('makeAmbientThrottle', () => {
  it('returns 0 (falsy) while less than one period has accumulated', () => {
    const amb = makeAmbientThrottle(20) // period = 50ms
    expect(amb(0.01)).toBe(0)
    expect(amb(0.01)).toBe(0)
    expect(amb(0.01)).toBe(0)
  })

  it('fires once the accumulated dt reaches the period, handing back the real elapsed time', () => {
    const amb = makeAmbientThrottle(20) // period = 50ms
    expect(amb(0.02)).toBe(0)
    expect(amb(0.02)).toBe(0)
    const elapsed = amb(0.02) // 0.06s accumulated, over the 0.05s period
    expect(elapsed).toBeCloseTo(0.06, 10)
  })

  it('resets after firing — the next call starts a fresh accumulation, not a fixed step', () => {
    const amb = makeAmbientThrottle(20)
    amb(0.06) // fires immediately, resets to 0
    expect(amb(0.01)).toBe(0) // fresh accumulation, not "already over period"
  })

  it('conserves total elapsed time across many small, irregular steps — the no-slow-motion property', () => {
    const amb = makeAmbientThrottle(20)
    const dts = Array.from({ length: 500 }, () => 0.001 + Math.random() * 0.01) // ~1-11ms, like real frame jitter
    const totalIn = dts.reduce((a, b) => a + b, 0)
    let totalOut = 0
    for (const dt of dts) totalOut += amb(dt)
    // Whatever hasn't fired yet is still sitting in the accumulator, not
    // lost — so totalOut is within one period of totalIn, never more.
    expect(totalIn - totalOut).toBeLessThan(1 / 20)
    expect(totalOut).toBeLessThanOrEqual(totalIn)
  })

  it('two independent throttles (as two modules would each own) never share state', () => {
    const a = makeAmbientThrottle(20)
    const b = makeAmbientThrottle(20)
    a(0.04)
    expect(b(0.02)).toBe(0) // b's own accumulator, unaffected by a's calls
  })
})
