import { describe, it, expect } from 'vitest'
import { CharacterRegistry } from '../src/characters.js'
import { Subscription } from '../src/subscribe.js'

function presence(agent: string, human: string, path = 'src/a.ts', verb = 'edit') {
  return { type: 'presence', agent, human, verb, region: { path, symbol: 'f' }, rung: 0 }
}

describe('Subscription', () => {
  it('spawns a character from a presence message', () => {
    const r = new CharacterRegistry()
    new Subscription(r).onMessage(presence('a1', 'dev'), 0)
    expect(r.all()).toHaveLength(1)
  })

  it('ignores malformed messages instead of throwing', () => {
    const r = new CharacterRegistry()
    const s = new Subscription(r)
    expect(() => s.onMessage({ type: 'presence' }, 0)).not.toThrow()
    expect(() => s.onMessage(null, 0)).not.toThrow()
    expect(() => s.onMessage('garbage', 0)).not.toThrow()
    expect(r.all()).toHaveLength(0)
  })

  it('gives full emphasis to every character — no hover system on this page', () => {
    const r = new CharacterRegistry()
    const s = new Subscription(r)
    s.onMessage(presence('a1', 'dev'), 0)
    expect(s.emphasis('a1')).toBe(1)
    expect(s.emphasis('nobody-home')).toBe(1)
  })

  // The join reply (relaysrv/relay.go's sendLeaseSnapshot) is type "leases"
  // with a bare `presence` array, not a "presence" frame — a joiner must
  // see a busy room immediately, not wait for the next live event.
  it('spawns characters from a "leases" join reply', () => {
    const r = new CharacterRegistry()
    const s = new Subscription(r)
    s.onMessage(
      {
        type: 'leases',
        leases: [],
        presence: [
          { agent: 'a1', human: 'dev', verb: 'edit', region: { path: 'src/a.ts' } },
          { agent: 'a2', human: 'sara', verb: 'read', region: { path: 'src/b.ts' } },
        ],
      },
      0,
    )
    expect(r.all()).toHaveLength(2)
  })

  it('drops leases entries that are not well-formed presence, keeps the rest', () => {
    const r = new CharacterRegistry()
    const s = new Subscription(r)
    s.onMessage(
      {
        type: 'leases',
        leases: [],
        presence: [
          { agent: 'a1', human: 'dev', verb: 'edit', region: { path: 'src/a.ts' } },
          { agent: 'a2' }, // missing required fields
        ],
      },
      0,
    )
    expect(r.all()).toHaveLength(1)
  })

  it('ignores a "leases" message whose presence field is missing or malformed', () => {
    const r = new CharacterRegistry()
    const s = new Subscription(r)
    expect(() => s.onMessage({ type: 'leases', leases: [] }, 0)).not.toThrow()
    expect(() => s.onMessage({ type: 'leases', presence: 'nope' }, 0)).not.toThrow()
    expect(r.all()).toHaveLength(0)
  })
})
