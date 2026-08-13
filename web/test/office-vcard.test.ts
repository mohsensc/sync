// replay-card.js: the off-by-default versus card. No jsdom/happy-dom is
// configured in this project (see package.json — vitest runs in plain
// node), so these tests exercise it the way office-caption.test.ts
// exercises the caption arbiter: a small fake standing in for the one
// piece of DOM surface the module actually touches (className,
// classList.add/remove, innerHTML), rather than pulling in a browser DOM.
// document itself is undefined in this environment; createReplayCard
// guards its one real DOM call (style injection) behind
// `typeof document !== 'undefined'`, so that's exercised implicitly by
// every test here just running at all.

import { describe, it, expect, vi, afterEach } from 'vitest'
import { createReplayCard } from '../src/office/replay-card.js'

function fakeContainer() {
  const classes = new Set<string>()
  return {
    className: '',
    innerHTML: '',
    classList: {
      add(c: string) { classes.add(c) },
      remove(c: string) { classes.delete(c) },
      contains(c: string) { return classes.has(c) },
    },
    has(c: string) { return classes.has(c) },
  }
}

const info = {
  a: { human: 'sara', agent: 'agent-1' },
  b: { human: 'dev', agent: 'agent-2' },
  rung: 3 as const,
  label: 'out-authoritied — aborted',
}

describe('createReplayCard: off by default', () => {
  it('is a no-op for a null/undefined/unknown variant', () => {
    for (const v of [null, undefined, '', 'nonsense']) {
      const c = fakeContainer()
      const card = createReplayCard(c as any, v as any)
      expect(card.variant).toBeNull()
      expect(() => card.show(info)).not.toThrow()
      expect(() => card.hide()).not.toThrow()
      expect(c.innerHTML).toBe('')
    }
  })
})

describe.each(['split', 'strip', 'ticket', 'bout'] as const)('createReplayCard: %s', (variant) => {
  it('renders both names and the label on show()', () => {
    const c = fakeContainer()
    const card = createReplayCard(c as any, variant)
    expect(card.variant).toBe(variant)
    card.show(info)
    expect(c.innerHTML).toContain('sara')
    expect(c.innerHTML).toContain('dev')
    expect(c.innerHTML).toContain('out-authoritied — aborted')
    expect(c.has('on')).toBe(true)
  })

  it('falls back to placeholder text for a blank party', () => {
    const c = fakeContainer()
    const card = createReplayCard(c as any, variant)
    card.show({ ...info, a: { human: '', agent: '' } })
    expect(c.innerHTML).toContain('unnamed agent')
  })
})

describe('createReplayCard: exit lifecycle', () => {
  afterEach(() => { vi.useRealTimers() })

  it('hide() drops the "on" class immediately but keeps markup during the fade', () => {
    vi.useFakeTimers()
    const c = fakeContainer()
    const card = createReplayCard(c as any, 'split')
    card.show(info)
    card.hide()
    expect(c.has('on')).toBe(false)
    expect(c.innerHTML).not.toBe('')   // still there mid-fade
  })

  it('clears markup only after the fade completes', () => {
    vi.useFakeTimers()
    const c = fakeContainer()
    const card = createReplayCard(c as any, 'split')
    card.show(info)
    card.hide()
    vi.advanceTimersByTime(299)
    expect(c.innerHTML).not.toBe('')
    vi.advanceTimersByTime(1)
    expect(c.innerHTML).toBe('')
  })

  it('a second hide() while already fading does not reschedule the clear', () => {
    vi.useFakeTimers()
    const c = fakeContainer()
    const card = createReplayCard(c as any, 'split')
    card.show(info)
    card.hide()
    vi.advanceTimersByTime(200)
    card.hide()   // must not push the clear further out
    vi.advanceTimersByTime(100)
    expect(c.innerHTML).toBe('')
  })

  it('show() during a pending exit cancels the clear and replaces content immediately', () => {
    vi.useFakeTimers()
    const c = fakeContainer()
    const card = createReplayCard(c as any, 'split')
    card.show(info)
    card.hide()
    vi.advanceTimersByTime(150)   // mid-fade, clear not fired yet
    card.show({ ...info, label: 'granted the lease, other waits' })
    expect(c.innerHTML).toContain('granted the lease')
    expect(c.has('on')).toBe(true)
    // The old exit's timer must be dead — advancing past when it would
    // have fired must not wipe the fresh content.
    vi.advanceTimersByTime(1000)
    expect(c.innerHTML).toContain('granted the lease')
  })

  it('show() after a completed exit works normally', () => {
    vi.useFakeTimers()
    const c = fakeContainer()
    const card = createReplayCard(c as any, 'strip')
    card.show(info)
    card.hide()
    vi.advanceTimersByTime(300)
    expect(c.innerHTML).toBe('')
    card.show(info)
    expect(c.innerHTML).not.toBe('')
    expect(c.has('on')).toBe(true)
  })
})
