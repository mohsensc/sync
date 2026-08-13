import { describe, it, expect } from 'vitest'
import { ReelStore, relTime } from '../src/office/reel.js'
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

describe('ReelStore detail toggle', () => {
  it('opens a row on first toggle', () => {
    const s = new ReelStore()
    expect(s.openId).toBeNull()
    s.toggleOpen('a')
    expect(s.openId).toBe('a')
  })

  it('closes the same row on a second toggle', () => {
    const s = new ReelStore()
    s.toggleOpen('a')
    s.toggleOpen('a')
    expect(s.openId).toBeNull()
  })

  it('switching to a different row replaces the open one, not stacks', () => {
    const s = new ReelStore()
    s.toggleOpen('a')
    s.toggleOpen('b')
    expect(s.openId).toBe('b')
  })

  it('closeOpen clears regardless of what was open', () => {
    const s = new ReelStore()
    s.toggleOpen('a')
    s.closeOpen()
    expect(s.openId).toBeNull()
  })
})

describe('ReelStore now-playing', () => {
  it('defaults to nothing playing', () => {
    const s = new ReelStore()
    expect(s.playingId).toBeNull()
  })

  it('setPlaying marks an id, clearPlaying resets it', () => {
    const s = new ReelStore()
    s.setPlaying('r3')
    expect(s.playingId).toBe('r3')
    s.clearPlaying()
    expect(s.playingId).toBeNull()
  })

  it('setPlaying(null) is the same as clearPlaying', () => {
    const s = new ReelStore()
    s.setPlaying('r3')
    s.setPlaying(null)
    expect(s.playingId).toBeNull()
  })
})

describe('ReelStore long-list handling', () => {
  function fill(s: ReelStore, n: number, over: Partial<ReelEvent> = {}) {
    for (let i = 0; i < n; i++) s.add(ev({ id: `e${i}`, ts: i, ...over }))
  }

  it('caps the page at the default reveal count', () => {
    const s = new ReelStore()
    fill(s, 55)
    const { shown, remaining } = s.page()
    expect(shown.length).toBe(40)
    expect(remaining).toBe(15)
  })

  it('does not cap when there are fewer events than the reveal count', () => {
    const s = new ReelStore()
    fill(s, 10)
    const { shown, remaining } = s.page()
    expect(shown.length).toBe(10)
    expect(remaining).toBe(0)
  })

  it('showMore raises the cap by the step size', () => {
    const s = new ReelStore()
    fill(s, 55)
    s.showMore()
    expect(s.page().shown.length).toBe(55)
    expect(s.page().remaining).toBe(0)
  })

  it('changing a filter resets the reveal cap back to the default', () => {
    const s = new ReelStore()
    fill(s, 55)
    s.showMore()
    expect(s.revealCount).toBe(80)
    s.setRungFilter(0)
    expect(s.revealCount).toBe(40)
    s.setHumanFilter('dev')
    expect(s.revealCount).toBe(40)
  })
})

describe('ReelStore arrival marking', () => {
  it('marks live-sourced events as newly arrived', () => {
    const s = new ReelStore()
    s.add(ev({ id: 'live-1', source: 'live' }))
    expect(s.takeNewLiveIds()).toEqual(['live-1'])
  })

  it('does not mark generated events as arrivals', () => {
    const s = new ReelStore()
    s.add(ev({ id: 'gen-1', source: 'generated' }))
    expect(s.takeNewLiveIds()).toEqual([])
  })

  it('seeding the constructor with live events marks them too', () => {
    const s = new ReelStore([ev({ id: 'live-1', source: 'live' }), ev({ id: 'gen-1', source: 'generated' })])
    expect(s.takeNewLiveIds()).toEqual(['live-1'])
  })

  it('consumes the queue — a second call returns nothing new', () => {
    const s = new ReelStore()
    s.add(ev({ id: 'live-1', source: 'live' }))
    s.takeNewLiveIds()
    expect(s.takeNewLiveIds()).toEqual([])
  })

  it('accumulates multiple arrivals between takes', () => {
    const s = new ReelStore()
    s.add(ev({ id: 'live-1', source: 'live' }))
    s.add(ev({ id: 'live-2', source: 'live' }))
    expect(s.takeNewLiveIds().sort()).toEqual(['live-1', 'live-2'])
  })
})

describe('relTime bucket formatting', () => {
  const now = 1_000_000

  it('reads "just now" for anything under 5 seconds', () => {
    expect(relTime(now - 0, now)).toBe('just now')
    expect(relTime(now - 4_000, now)).toBe('just now')
  })

  it('reads seconds between 5s and 1m', () => {
    expect(relTime(now - 5_000, now)).toBe('5s ago')
    expect(relTime(now - 59_000, now)).toBe('59s ago')
  })

  it('reads minutes between 1m and 1h', () => {
    expect(relTime(now - 60_000, now)).toBe('1m ago')
    expect(relTime(now - 59 * 60_000, now)).toBe('59m ago')
  })

  it('reads hours between 1h and 1d', () => {
    expect(relTime(now - 60 * 60_000, now)).toBe('1h ago')
    expect(relTime(now - 23 * 60 * 60_000, now)).toBe('23h ago')
  })

  it('reads days at 1d and beyond', () => {
    expect(relTime(now - 24 * 60 * 60_000, now)).toBe('1d ago')
    expect(relTime(now - 72 * 60 * 60_000, now)).toBe('3d ago')
  })

  it('never goes negative for a timestamp slightly in the future', () => {
    expect(relTime(now + 2_000, now)).toBe('just now')
  })
})
