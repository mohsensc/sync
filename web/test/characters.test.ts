import { describe, it, expect } from 'vitest'
import { CharacterRegistry, PRESENCE_TTL_MS, WALK_SPEED } from '../src/characters.js'
import { hairFor } from '../src/palette.js'

describe('CharacterRegistry', () => {
  it('spawns a character on first sight with that human\'s hair colour', () => {
    const r = new CharacterRegistry()
    r.upsert('a1', 'sara', 'edit', 'src/auth/session.ts', 0)
    const [c] = r.all()
    expect(c.agent).toBe('a1')
    expect(c.hair).toBe(hairFor('sara'))
  })

  it('routes the character to the zone matching the work', () => {
    const r = new CharacterRegistry()
    r.upsert('a1', 'sara', 'edit', 'src/auth/session.ts', 0)
    expect(r.all()[0].zone).toBe('vault')
  })

  it('retargets when the same agent starts different work', () => {
    const r = new CharacterRegistry()
    r.upsert('a1', 'sara', 'edit', 'src/auth/session.ts', 0)
    r.upsert('a1', 'sara', 'edit', 'package.json', 100)
    expect(r.all()).toHaveLength(1)
    expect(r.all()[0].zone).toBe('cables')
  })

  it('walks toward the target rather than teleporting', () => {
    const r = new CharacterRegistry()
    r.upsert('a1', 'sara', 'edit', 'src/auth/session.ts', 0)
    // all() hands back the live objects, so c tracks each step.
    const c = r.all()[0]
    const start = { x: c.x, z: c.z }
    const target = { x: c.targetX, z: c.targetZ }
    const total = Math.hypot(target.x - start.x, target.z - start.z)

    const dt = 0.1
    const cap = WALK_SPEED * dt

    // Reception to the vault is a walk you can watch, not a hop. If it ever
    // gets short enough to cross in one tick the rest of this proves nothing.
    expect(total).toBeGreaterThan(cap * 20)

    r.step(dt)
    // One tick buys exactly one tick's worth of ground.
    expect(Math.hypot(c.x - start.x, c.z - start.z)).toBeCloseTo(cap, 10)
    // And leaves the rest still to cover. A teleport would already be there.
    expect(Math.hypot(target.x - c.x, target.z - c.z)).toBeCloseTo(total - cap, 10)

    let prev = { x: c.x, z: c.z }
    for (let i = 0; i < 20; i++) {
      r.step(dt)
      const moved = Math.hypot(c.x - prev.x, c.z - prev.z)
      expect(moved).toBeLessThanOrEqual(cap + 1e-9)
      expect(moved).toBeCloseTo(cap, 10)
      // Straight line: the cross product against the start-to-target vector
      // stays zero, so it is not wandering or snapping sideways.
      const cross = (c.x - start.x) * (target.z - start.z) - (c.z - start.z) * (target.x - start.x)
      expect(cross).toBeCloseTo(0, 8)
      prev = { x: c.x, z: c.z }
    }

    // Twice the timestep, twice the ground: the movement is dt-driven, not a
    // fixed nudge that happens to look incremental.
    const before = { x: c.x, z: c.z }
    r.step(dt * 2)
    expect(Math.hypot(c.x - before.x, c.z - before.z)).toBeCloseTo(cap * 2, 10)

    // It does get there, and it stops there rather than sailing past.
    for (let i = 0; i < 200; i++) r.step(dt)
    expect(Math.hypot(target.x - c.x, target.z - c.z)).toBeLessThan(1e-9)
  })

  it('expires a character whose agent has gone quiet', () => {
    const r = new CharacterRegistry()
    r.upsert('a1', 'sara', 'edit', 'a.ts', 0)
    r.expire(PRESENCE_TTL_MS + 1)
    expect(r.all()).toHaveLength(0)
  })

  it('keeps several agents for one human distinct but same-coloured', () => {
    const r = new CharacterRegistry()
    r.upsert('a1', 'sara', 'edit', 'a.ts', 0)
    r.upsert('a2', 'sara', 'edit', 'b.ts', 0)
    const mine = r.byHuman('sara')
    expect(mine).toHaveLength(2)
    expect(mine[0].hair).toBe(mine[1].hair)
  })
})
