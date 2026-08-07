import { describe, it, expect } from 'vitest'
import { CharacterRegistry, PRESENCE_TTL_MS } from '../src/characters.js'
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
    const before = r.all()[0].x
    r.step(0.1)
    const after = r.all()[0].x
    expect(after).not.toBe(before)
    expect(Math.abs(after - before)).toBeLessThan(5)
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
