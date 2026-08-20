import { describe, it, expect } from 'vitest'
import { ReelStore, relTime, SAMPLE_EVENTS, SORT_MODES } from '../src/office/reel.js'
import { seedEvents } from '../src/office/seed.js'
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

  it('inserts an out-of-order ts into the middle, not just the front', () => {
    const s = new ReelStore()
    s.add(ev({ id: 'a', ts: 100 }))
    s.add(ev({ id: 'b', ts: 50 }))
    s.add(ev({ id: 'c', ts: 75 })) // older than a, newer than b — belongs between them
    expect(s.visible().map(e => e.id)).toEqual(['a', 'c', 'b'])
  })

  it('an event older than everything lands at the tail', () => {
    const s = new ReelStore()
    s.add(ev({ id: 'a', ts: 100 }))
    s.add(ev({ id: 'b', ts: 200 }))
    s.add(ev({ id: 'c', ts: 1 }))
    expect(s.visible().map(e => e.id)).toEqual(['b', 'a', 'c'])
  })

  it('same-ts inserts keep insertion order (stable, newest-batch-last)', () => {
    const s = new ReelStore()
    s.add(ev({ id: 'first', ts: 10 }))
    s.add(ev({ id: 'second', ts: 10 }))
    s.add(ev({ id: 'third', ts: 10 }))
    expect(s.visible().map(e => e.id)).toEqual(['first', 'second', 'third'])
  })
})

describe('ReelStore event cap', () => {
  it('does not grow past MAX_EVENTS', () => {
    const s = new ReelStore()
    for (let i = 0; i < 1200; i++) s.add(ev({ id: `e${i}`, ts: i }))
    expect(s.size).toBe(1000)
  })

  it('drops the oldest events once past the cap, keeping the newest', () => {
    const s = new ReelStore()
    for (let i = 0; i < 1200; i++) s.add(ev({ id: `e${i}`, ts: i }))
    const ids = s.all().map(e => e.id)
    expect(ids[0]).toBe('e1199') // newest survives
    expect(ids[ids.length - 1]).toBe('e200') // events 0..199 aged out
    expect(ids).not.toContain('e0')
  })

  it('a very old out-of-order event past a full store is dropped, not kept', () => {
    const s = new ReelStore()
    for (let i = 0; i < 1000; i++) s.add(ev({ id: `e${i}`, ts: i + 1000 }))
    s.add(ev({ id: 'ancient', ts: 1 })) // older than every existing entry
    expect(s.size).toBe(1000)
    expect(s.all().map(e => e.id)).not.toContain('ancient')
  })

  it('drawn subset (page().shown) for the common under-cap path is unchanged', () => {
    const s = new ReelStore()
    for (let i = 0; i < 55; i++) s.add(ev({ id: `e${i}`, ts: i }))
    const { shown } = s.page()
    expect(shown.length).toBe(40)
    expect(shown.map(e => e.id)).toEqual(
      Array.from({ length: 40 }, (_, i) => `e${54 - i}`)
    )
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

describe('ReelStore sort mode', () => {
  it('defaults to "new" — chronological, unchanged behavior', () => {
    const s = new ReelStore()
    expect(s.sortMode).toBe('new')
  })

  it('falls back to "new" for anything unrecognized', () => {
    const s = new ReelStore()
    s.setSortMode('worst')
    expect(s.sortMode).toBe('worst')
    // @ts-expect-error deliberately passing a bad value, same posture as resolveSkin
    s.setSortMode('deadliest')
    expect(s.sortMode).toBe('new')
  })

  it('"new" sorts newest first regardless of rung', () => {
    const s = new ReelStore()
    s.add(ev({ id: 'a', ts: 1, rung: 4 }))
    s.add(ev({ id: 'b', ts: 3, rung: 0 }))
    s.add(ev({ id: 'c', ts: 2, rung: 2 }))
    s.setSortMode('new')
    expect(s.visible().map(e => e.id)).toEqual(['b', 'c', 'a'])
  })

  it('"worst" sorts by rung descending', () => {
    const s = new ReelStore()
    s.add(ev({ id: 'low', ts: 3, rung: 0 }))
    s.add(ev({ id: 'high', ts: 1, rung: 4 }))
    s.add(ev({ id: 'mid', ts: 2, rung: 2 }))
    s.setSortMode('worst')
    expect(s.visible().map(e => e.id)).toEqual(['high', 'mid', 'low'])
  })

  it('"worst" ties within a rung break newest-first', () => {
    const s = new ReelStore()
    s.add(ev({ id: 'r3-old', ts: 1, rung: 3 }))
    s.add(ev({ id: 'r3-new', ts: 9, rung: 3 }))
    s.add(ev({ id: 'r3-mid', ts: 5, rung: 3 }))
    s.setSortMode('worst')
    expect(s.visible().map(e => e.id)).toEqual(['r3-new', 'r3-mid', 'r3-old'])
  })

  it('"worst-grouped" sorts identically to "worst" — grouping is a render concern', () => {
    const s1 = new ReelStore()
    const s2 = new ReelStore()
    for (const s of [s1, s2]) {
      s.add(ev({ id: 'a', ts: 1, rung: 4 }))
      s.add(ev({ id: 'b', ts: 3, rung: 0 }))
      s.add(ev({ id: 'c', ts: 2, rung: 3 }))
    }
    s1.setSortMode('worst')
    s2.setSortMode('worst-grouped')
    expect(s2.visible().map(e => e.id)).toEqual(s1.visible().map(e => e.id))
  })

  it('sort respects the active filters, same as "new" does', () => {
    const s = new ReelStore()
    s.add(ev({ id: 'keep', ts: 1, rung: 4, a: { agent: 'agent-1', human: 'priya' } }))
    s.add(ev({ id: 'drop', ts: 2, rung: 3, a: { agent: 'agent-1', human: 'someone-else' } }))
    s.setHumanFilter('priya')
    s.setSortMode('worst')
    expect(s.visible().map(e => e.id)).toEqual(['keep'])
  })

  it('switching sort mode does not reset the reveal cap, unlike a filter change', () => {
    const s = new ReelStore()
    for (let i = 0; i < 55; i++) s.add(ev({ id: `e${i}`, ts: i }))
    s.showMore()
    expect(s.revealCount).toBe(80)
    s.setSortMode('worst')
    expect(s.revealCount).toBe(80)
  })

  it('every declared sort mode round-trips through setSortMode', () => {
    const s = new ReelStore()
    for (const mode of SORT_MODES) {
      s.setSortMode(mode)
      expect(s.sortMode).toBe(mode)
    }
  })
})

describe('ReelStore with the real seed history (reel.js SAMPLE_EVENTS + seed.js)', () => {
  const build = () => new ReelStore([...SAMPLE_EVENTS, ...seedEvents(1_700_000_000_000)])

  it('has enough rows that paging actually triggers', () => {
    const s = build()
    const { shown, remaining } = s.page()
    expect(shown.length).toBe(40) // REVEAL_STEP
    expect(remaining).toBeGreaterThan(0)
  })

  it('showMore eventually reveals everything', () => {
    const s = build()
    while (s.page().remaining > 0) s.showMore()
    expect(s.page().shown.length).toBe(s.visible().length)
  })

  it('has at least one human×rung combo that filters down to empty', () => {
    const s = build()
    s.setRungFilter(4)
    s.setHumanFilter('sara')
    expect(s.visible()).toEqual([])
  })

  it('is not the case that every human×rung combo is populated', () => {
    // The failure mode the brief called out by name: if this ever comes
    // back true, the seed data got too dense again to reach the empty
    // state through the filters.
    const s = build()
    let sawEmpty = false
    for (const human of s.humans()) {
      for (const rung of [0, 1, 2, 3, 4] as const) {
        s.setRungFilter(rung)
        s.setHumanFilter(human)
        if (s.visible().length === 0) sawEmpty = true
      }
    }
    expect(sawEmpty).toBe(true)
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
