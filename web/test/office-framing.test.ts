import { describe, it, expect } from 'vitest'
import { yawMiss, headFraming, pickFraming, resolveFrameMode } from '../src/office/framing.js'
import { ZONES } from '../src/office/zones.js'

// #64: threequarter alone put front-row desks (yaw 0, facing their own desk
// away from the room's reachable orbit arc) on the back of the head, because
// a.yaw + PI landed the target yaw way outside the arc while the shoulder
// target (built off a.yaw directly) landed right in it. pickFraming picks
// whichever candidate the room's clamp has to displace less, real desk yaws
// included so a regression in either framing's offset constants — not just
// in the picker's own comparison — would show up here too.
const [frontRow] = ZONES.desks.slots  // [-2.6, -1.35, 0]
const backRow = ZONES.desks.slots[3]  // [-2.6, 0.35, Math.PI]

describe('pickFraming', () => {
  it('keeps threequarter for back-row desks — flipping a near-zero miss would regress', () => {
    const a = { yaw: backRow[2] }
    const picked = pickFraming(a)
    const threequarter = headFraming(a, 'threequarter')
    expect(picked).toEqual(threequarter)
    expect(yawMiss(threequarter.yaw)).toBeCloseTo(0.02, 2)
  })

  it('picks shoulder for front-row desks, where threequarter misses by over 90 degrees', () => {
    const a = { yaw: frontRow[2] }
    const picked = pickFraming(a)
    const shoulder = headFraming(a, 'shoulder')
    expect(picked).toEqual(shoulder)
    expect(yawMiss(headFraming(a, 'threequarter').yaw)).toBeGreaterThan(Math.PI / 2)
  })

  it('when both candidates miss, picks the smaller miss', () => {
    const a = { yaw: -1.5 }
    const threequarterMiss = yawMiss(headFraming(a, 'threequarter').yaw)
    const shoulderMiss = yawMiss(headFraming(a, 'shoulder').yaw)
    expect(threequarterMiss).toBeGreaterThan(0)
    expect(shoulderMiss).toBeGreaterThan(0)
    expect(threequarterMiss).toBeLessThan(shoulderMiss)
    expect(pickFraming(a)).toEqual(headFraming(a, 'threequarter'))
  })

  it('keeps threequarter even when shoulder misses slightly less, inside PREFER_MARGIN', () => {
    // At this yaw shoulder's miss (~0.91) beats threequarter's (~0.96) — but
    // only by ~0.05 rad, well under the 0.15 margin threequarter gets as the
    // documented default. Drop the margin from pickFraming's comparison and
    // this flips to shoulder; that's the bug this test is here to catch.
    const a = { yaw: -0.95 }
    const threequarterMiss = yawMiss(headFraming(a, 'threequarter').yaw)
    const shoulderMiss = yawMiss(headFraming(a, 'shoulder').yaw)
    expect(shoulderMiss).toBeLessThan(threequarterMiss)
    expect(threequarterMiss - shoulderMiss).toBeLessThan(0.15)
    expect(pickFraming(a)).toEqual(headFraming(a, 'threequarter'))
  })

  it('an explicit mode bypasses the picker — headFraming alone does not weigh misses', () => {
    // Front row is the case pickFraming steers to shoulder; headFraming with
    // an explicit pin has to hand back threequarter anyway, same as a
    // ?frame=threequarter pin in office.html would force for every agent.
    const a = { yaw: frontRow[2] }
    expect(headFraming(a, 'threequarter')).not.toEqual(pickFraming(a))
    expect(headFraming(a, 'threequarter').yaw).toBeCloseTo(a.yaw + Math.PI + 0.16, 10)
  })
})

describe('resolveFrameMode', () => {
  it('accepts the two explicit pins as-is', () => {
    expect(resolveFrameMode('shoulder')).toBe('shoulder')
    expect(resolveFrameMode('threequarter')).toBe('threequarter')
  })

  it('round-trips back to the picker default (null) from a pin', () => {
    expect(resolveFrameMode('shoulder')).toBe('shoulder')
    // office.html's setFrame(m) calls this on every invocation — anything
    // that isn't an exact pin, including no argument, has to clear back to
    // null rather than getting stuck coerced to 'threequarter' forever.
    expect(resolveFrameMode(undefined)).toBeNull()
    expect(resolveFrameMode(null)).toBeNull()
    expect(resolveFrameMode('auto')).toBeNull()
  })
})
