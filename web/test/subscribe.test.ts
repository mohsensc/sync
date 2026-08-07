import { describe, it, expect } from 'vitest'
import { CharacterRegistry } from '../src/characters.js'
import { Subscription } from '../src/subscribe.js'

function presence(agent: string, human: string, path = 'src/a.ts', verb = 'edit') {
  return { type: 'presence', agent, human, verb, region: { path, symbol: 'f' }, rung: 0 }
}

describe('Subscription', () => {
  it('spawns a character from a presence message', () => {
    const r = new CharacterRegistry()
    new Subscription(r, 'sara').onMessage(presence('a1', 'dev'), 0)
    expect(r.all()).toHaveLength(1)
  })

  it('ignores malformed messages instead of throwing', () => {
    const r = new CharacterRegistry()
    const s = new Subscription(r, 'sara')
    expect(() => s.onMessage({ type: 'presence' }, 0)).not.toThrow()
    expect(() => s.onMessage(null, 0)).not.toThrow()
    expect(() => s.onMessage('garbage', 0)).not.toThrow()
    expect(r.all()).toHaveLength(0)
  })

  it('gives full emphasis to everyone when nothing is hovered', () => {
    const r = new CharacterRegistry()
    const s = new Subscription(r, 'sara')
    s.onMessage(presence('a1', 'dev'), 0)
    expect(s.emphasis('a1')).toBe(1)
  })

  it('desaturates everyone else while a human is hovered', () => {
    const r = new CharacterRegistry()
    const s = new Subscription(r, 'sara')
    s.onMessage(presence('a1', 'dev'), 0)
    s.onMessage(presence('a2', 'sara'), 0)
    s.setHover('sara')
    expect(s.emphasis('a2')).toBe(1)
    expect(s.emphasis('a1')).toBeLessThan(1)
  })

  it('restores everyone when the hover clears', () => {
    const r = new CharacterRegistry()
    const s = new Subscription(r, 'sara')
    s.onMessage(presence('a1', 'dev'), 0)
    s.setHover('sara')
    s.setHover(null)
    expect(s.emphasis('a1')).toBe(1)
  })

  it('tracks contested regions so a collision can be rendered', () => {
    const r = new CharacterRegistry()
    const s = new Subscription(r, 'sara')
    s.onMessage({ ...presence('a1', 'dev'), rung: 3 }, 0)
    expect(s.contested()).toContain('a1')
  })
})
