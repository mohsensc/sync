import { describe, it, expect, vi } from 'vitest'
import { createCaptionArbiter, PRIORITY } from '../src/office/caption.js'

describe('caption arbiter', () => {
  it('writes through when nothing holds the caption', () => {
    const write = vi.fn()
    const arb = createCaptionArbiter(write)
    const ok = arb.set('hello', { priority: PRIORITY.demo })
    expect(ok).toBe(true)
    expect(write).toHaveBeenCalledWith('hello')
  })

  it('a replay hold blocks lower-priority demo writes', () => {
    const write = vi.fn()
    const arb = createCaptionArbiter(write)
    const token = arb.hold(PRIORITY.replay)
    arb.set('replay: a vs b', { priority: PRIORITY.replay })
    write.mockClear()

    const dropped = arb.set('demo line', { priority: PRIORITY.demo })
    expect(dropped).toBe(false)
    expect(write).not.toHaveBeenCalled()

    arb.release(token)
    const ok = arb.set('demo line', { priority: PRIORITY.demo })
    expect(ok).toBe(true)
    expect(write).toHaveBeenCalledWith('demo line')
  })

  it('a same-or-higher priority write while held still goes through', () => {
    const write = vi.fn()
    const arb = createCaptionArbiter(write)
    arb.hold(PRIORITY.replay)
    const ok = arb.set('replay: updated', { priority: PRIORITY.replay })
    expect(ok).toBe(true)
    expect(write).toHaveBeenCalledWith('replay: updated')
  })

  it('releasing a stale token does not clear a newer hold', () => {
    const write = vi.fn()
    const arb = createCaptionArbiter(write)
    const staleToken = arb.hold(PRIORITY.replay)
    arb.release(staleToken)
    const freshToken = arb.hold(PRIORITY.replay)
    arb.release(staleToken)   // stale: must not release the fresh hold
    expect(arb.isHeld()).toBe(true)
    arb.release(freshToken)
    expect(arb.isHeld()).toBe(false)
  })

  it('isHeld reflects current state', () => {
    const arb = createCaptionArbiter(() => {})
    expect(arb.isHeld()).toBe(false)
    const token = arb.hold(PRIORITY.replay)
    expect(arb.isHeld()).toBe(true)
    arb.release(token)
    expect(arb.isHeld()).toBe(false)
  })
})
