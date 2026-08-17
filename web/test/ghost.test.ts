import { describe, it, expect } from 'vitest'
import { decideGhostTreatment, plateText, ENCOUNTER_ARGUE_DAYS } from '../src/office/ghost.js'
import ghostSrc from '../src/office/ghost.js?raw'

// -- degrade paths: never an empty ghost -------------------------------

describe('decideGhostTreatment — degrade paths', () => {
  it('untracked path (ok:false) -> none', () => {
    expect(decideGhostTreatment({ ok: false, reason: 'no blame available' }, [])).toEqual({ kind: 'none' })
  })

  it('empty owners list -> none', () => {
    expect(decideGhostTreatment({ ok: true, owners: [], total: 0 }, [])).toEqual({ kind: 'none' })
  })

  it('missing/malformed body -> none', () => {
    expect(decideGhostTreatment(null, [])).toEqual({ kind: 'none' })
    expect(decideGhostTreatment(undefined, [])).toEqual({ kind: 'none' })
    expect(decideGhostTreatment({ ok: true }, [])).toEqual({ kind: 'none' })
  })

  it('mode "off" always returns none, even with usable blame and a match', () => {
    const blame = { ok: true, owners: [{ author: 'mohsensc', lines: 40, share: 1 }], newestLineAgeDays: 1 }
    const roster = [{ id: 'b2', human: 'mohsensc', busy: false }]
    expect(decideGhostTreatment(blame, roster, { mode: 'off', selfId: 'a2' })).toEqual({ kind: 'none' })
  })
})

// -- passive treatments (ghost / plate) ---------------------------------

describe('decideGhostTreatment — multi-author, no in-room match', () => {
  it('picks owners[0] as the majority author and passes through the current mode', () => {
    const blame = {
      ok: true,
      owners: [
        { author: 'mohsensc', lines: 30, share: 0.75 },
        { author: 'rae', lines: 10, share: 0.25 },
      ],
      newestLineAgeDays: 12,
    }
    const roster = [{ id: 'a1', human: null, busy: false }, { id: 'a3', human: 'rae', busy: true }]
    expect(decideGhostTreatment(blame, roster, { mode: 'ghost', selfId: 'a2' }))
      .toEqual({ kind: 'ghost', author: 'mohsensc', ageDays: 12 })
    expect(decideGhostTreatment(blame, roster, { mode: 'plate', selfId: 'a2' }))
      .toEqual({ kind: 'plate', author: 'mohsensc', ageDays: 12 })
  })
})

describe('decideGhostTreatment — single author, no in-room match', () => {
  it('still resolves cleanly with only one owner', () => {
    const blame = { ok: true, owners: [{ author: 'mohsensc', lines: 12, share: 1 }], newestLineAgeDays: 40 }
    expect(decideGhostTreatment(blame, [], { mode: 'ghost', selfId: 'a1' }))
      .toEqual({ kind: 'ghost', author: 'mohsensc', ageDays: 40 })
  })

  it('missing newestLineAgeDays degrades to ageDays: null, not a crash', () => {
    const blame = { ok: true, owners: [{ author: 'mohsensc', lines: 12, share: 1 }] }
    expect(decideGhostTreatment(blame, [], { mode: 'plate', selfId: 'a1' }))
      .toEqual({ kind: 'plate', author: 'mohsensc', ageDays: null })
  })
})

// -- author present in the room: encounter -------------------------------

describe('decideGhostTreatment — author present in the room', () => {
  const roster = [
    { id: 'a1', human: null, busy: false },
    { id: 'b2', human: 'mohsensc', busy: false },
  ]

  it('recent blame (<= ENCOUNTER_ARGUE_DAYS) fires argue', () => {
    const blame = { ok: true, owners: [{ author: 'mohsensc', lines: 20, share: 1 }], newestLineAgeDays: 3 }
    expect(decideGhostTreatment(blame, roster, { mode: 'ghost', selfId: 'a2' }))
      .toEqual({ kind: 'encounter', author: 'mohsensc', ageDays: 3, partnerId: 'b2', clip: 'argue' })
  })

  it('blame exactly at the threshold still counts as recent (<=, not <)', () => {
    const blame = { ok: true, owners: [{ author: 'mohsensc', lines: 20, share: 1 }], newestLineAgeDays: ENCOUNTER_ARGUE_DAYS }
    const d = decideGhostTreatment(blame, roster, { mode: 'ghost', selfId: 'a2' })
    expect(d.kind === 'encounter' && d.clip).toBe('argue')
  })

  it('older blame fires handshake', () => {
    const blame = { ok: true, owners: [{ author: 'mohsensc', lines: 20, share: 1 }], newestLineAgeDays: 90 }
    expect(decideGhostTreatment(blame, roster, { mode: 'ghost', selfId: 'a2' }))
      .toEqual({ kind: 'encounter', author: 'mohsensc', ageDays: 90, partnerId: 'b2', clip: 'handshake' })
  })

  it('unknown age (null) treats the encounter as old enough for a handshake, not an argue', () => {
    const blame = { ok: true, owners: [{ author: 'mohsensc', lines: 20, share: 1 }] }
    const d = decideGhostTreatment(blame, roster, { mode: 'ghost', selfId: 'a2' })
    expect(d.kind === 'encounter' && d.clip).toBe('handshake')
  })

  it('a busy partner is not a valid encounter target — falls back to the passive mode', () => {
    const busyRoster = [{ id: 'b2', human: 'mohsensc', busy: true }]
    const blame = { ok: true, owners: [{ author: 'mohsensc', lines: 20, share: 1 }], newestLineAgeDays: 3 }
    expect(decideGhostTreatment(blame, busyRoster, { mode: 'ghost', selfId: 'a2' }))
      .toEqual({ kind: 'ghost', author: 'mohsensc', ageDays: 3 })
  })

  it('the editing agent itself is excluded from the roster search (no self-encounter)', () => {
    const selfRoster = [{ id: 'a2', human: 'mohsensc', busy: false }]
    const blame = { ok: true, owners: [{ author: 'mohsensc', lines: 20, share: 1 }], newestLineAgeDays: 3 }
    expect(decideGhostTreatment(blame, selfRoster, { mode: 'ghost', selfId: 'a2' }))
      .toEqual({ kind: 'ghost', author: 'mohsensc', ageDays: 3 })
  })

  it('an agent with no human/role set can never match', () => {
    const noHuman = [{ id: 'b2', human: null, busy: false }, { id: 'b3', human: '', busy: false }]
    const blame = { ok: true, owners: [{ author: 'mohsensc', lines: 20, share: 1 }], newestLineAgeDays: 3 }
    expect(decideGhostTreatment(blame, noHuman, { mode: 'ghost', selfId: 'a2' }).kind).toBe('ghost')
  })

  it('plate mode also yields an encounter, not a plate, when a match exists', () => {
    const blame = { ok: true, owners: [{ author: 'mohsensc', lines: 20, share: 1 }], newestLineAgeDays: 3 }
    expect(decideGhostTreatment(blame, roster, { mode: 'plate', selfId: 'a2' }).kind).toBe('encounter')
  })
})

// -- copy -----------------------------------------------------------------

describe('plateText', () => {
  it('reads as one line: what happened, when, who', () => {
    expect(plateText('mohsensc', 5)).toBe('wrote most of this · 5d ago · mohsensc')
  })
  it('degrades age gracefully instead of printing "NaN" or "undefined"', () => {
    expect(plateText('mohsensc', null)).toBe('wrote most of this · a while back · mohsensc')
    expect(plateText('mohsensc', 0)).toBe('wrote most of this · today · mohsensc')
    expect(plateText('mohsensc', 1)).toBe('wrote most of this · 1d ago · mohsensc')
    expect(plateText('mohsensc', 62)).toBe('wrote most of this · 2mo ago · mohsensc')
  })
})

// -- pose-once, not per-frame mixer update ---------------------------------
//
// A ghost is meant to read as parked, not animated (see the file header).
// This used to mean ANIM.update(s.figRoot, dt) ran every frame for every
// ghost on screen — a full AnimationMixer + skeleton evaluation on a
// cloned skinned mesh, repeated for a figure that never actually needed
// to move past its first pose. It's a THREE/AnimationMixer effect with no
// pure-JS surface to unit test against rendered output, so this pins the
// call-site structure instead: a static source scan, same shape as
// office-frame-loop.test.ts's rAF scan above it in this round. Weaker than
// a behavioural assertion, but it does fail against the old code (which
// had neither the build-time pose-land call nor an empty tick(dt)) and
// pass against the new.
describe('ghost pose — mixer update happens once, at build, not per frame', () => {
  it('lands the idle pose once, right after the crossfade that starts it', () => {
    expect(ghostSrc).toContain('ANIM.crossfade(figRoot, \'idle\', 0)')
    expect(ghostSrc).toContain('ANIM.update(figRoot, 0)')
  })

  it('never calls ANIM.update against a per-frame `dt` (the old per-ghost mixer step)', () => {
    // The old frame loop called `ANIM.update(s.figRoot, dt)` on every
    // tick. Any `ANIM.update(<anything>, dt)` call left in the file would
    // mean some code path still drives the mixer every frame.
    expect(ghostSrc).not.toMatch(/ANIM\.update\([^)]*,\s*dt\)/)
  })
})
