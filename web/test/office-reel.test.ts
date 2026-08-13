import { describe, it, expect } from 'vitest'
import { ReelStore } from '../src/office/reel.js'
import type { ReelEvent } from '../src/office/reel.js'

function ev(over: Partial<ReelEvent> = {}): ReelEvent {
  return {
    id: over.id ?? Math.random().toString(36).slice(2),
    ts: over.ts ?? 0,
    rung: over.rung ?? 0,
    a: over.a ?? { agent: 'agent-1', human: 'sara' },
    b: over.b ?? { agent: 'agent-2', human: 'dev' },
    path: over.path ?? 'src/a.ts',
    resolution: over.resolution ?? null,
    source: over.source ?? 'generated',
  }
}

describe('ReelStore ordering', () => {
  it('starts empty', () => {
    const s = new ReelStore()
    expect(s.size).toBe(0)
    expect(s.visible()).toEqual([])
  })

  it('sorts newest first regardless of insertion order', () => {
    const s = new ReelStore()
    s.add(ev({ id: 'old', ts: 100 }))
    s.add(ev({ id: 'newest', ts: 300 }))
    s.add(ev({ id: 'mid', ts: 200 }))
    expect(s.visible().map(e => e.id)).toEqual(['newest', 'mid', 'old'])
  })

  it('seeds from the constructor in the same sorted order', () => {
    const s = new ReelStore([ev({ id: 'a', ts: 1 }), ev({ id: 'b', ts: 5 })])
    expect(s.visible().map(e => e.id)).toEqual(['b', 'a'])
  })
})

describe('ReelStore filtering', () => {
  it('filters by rung, defaulting to all', () => {
    const s = new ReelStore()
    s.add(ev({ id: 'r0', rung: 0, ts: 3 }))
    s.add(ev({ id: 'r3', rung: 3, ts: 2 }))
    s.add(ev({ id: 'r4', rung: 4, ts: 1 }))
    expect(s.visible().map(e => e.id)).toEqual(['r0', 'r3', 'r4'])
    s.setRungFilter(3)
    expect(s.visible().map(e => e.id)).toEqual(['r3'])
    s.setRungFilter('all')
    expect(s.visible().length).toBe(3)
  })

  it('filters by human on either side of the pair', () => {
    const s = new ReelStore()
    s.add(ev({ id: 'x', ts: 2, a: { agent: 'agent-1', human: 'priya' }, b: { agent: 'agent-2', human: 'dev' } }))
    s.add(ev({ id: 'y', ts: 1, a: { agent: 'agent-3', human: 'dev' }, b: { agent: 'agent-4', human: 'priya' } }))
    s.add(ev({ id: 'z', ts: 0, a: { agent: 'agent-5', human: 'sara' }, b: { agent: 'agent-1', human: 'sara' } }))
    s.setHumanFilter('priya')
    expect(s.visible().map(e => e.id)).toEqual(['x', 'y'])
    s.setHumanFilter('all')
    expect(s.visible().length).toBe(3)
  })

  it('combines rung and human filters', () => {
    const s = new ReelStore()
    s.add(ev({ id: 'match', ts: 2, rung: 2, a: { agent: 'agent-1', human: 'priya' }, b: { agent: 'agent-2', human: 'dev' } }))
    s.add(ev({ id: 'wrong-rung', ts: 1, rung: 3, a: { agent: 'agent-1', human: 'priya' }, b: { agent: 'agent-2', human: 'dev' } }))
    s.add(ev({ id: 'wrong-human', ts: 0, rung: 2, a: { agent: 'agent-3', human: 'sara' }, b: { agent: 'agent-4', human: 'dev' } }))
    s.setRungFilter(2)
    s.setHumanFilter('priya')
    expect(s.visible().map(e => e.id)).toEqual(['match'])
  })

  it('returns an empty list, not an error, when a filter matches nothing', () => {
    const s = new ReelStore([ev({ id: 'only', rung: 0 })])
    s.setRungFilter(4)
    expect(s.visible()).toEqual([])
  })

  it('lists the humans present, deduped and sorted', () => {
    const s = new ReelStore()
    s.add(ev({ a: { agent: 'agent-1', human: 'sara' }, b: { agent: 'agent-2', human: 'dev' } }))
    s.add(ev({ a: { agent: 'agent-3', human: 'dev' }, b: { agent: 'agent-4', human: 'priya' } }))
    expect(s.humans()).toEqual(['dev', 'priya', 'sara'])
  })
})
