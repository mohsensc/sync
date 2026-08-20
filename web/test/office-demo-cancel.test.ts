// demo.js's cancellation core (#152): wait() races setTimeout against
// tok.dead, race() races a promise against tok.rejects, cancel() flips
// dead, clears timers, and rejects whatever race() registered. None of it
// had coverage. The bug class: a beat whose promise never went through
// race() survives cancel() and can still be running when the demo restarts.
//
// No jsdom/happy-dom here (see office-vcard.test.ts) — document is
// undefined in this environment. runDemo() only touches DOM once, in
// symbolTexture()'s canvas text (the contested-symbol sprite), and never
// reads anything back from it, so a Proxy that swallows every call/set is
// enough. That's the only stub this harness needs; three.js itself
// constructs fine in plain node (Object3D/Scene/Group/Mesh don't touch the
// DOM), so there's no reason to mock 'three'.
//
// Agents are stubbed just enough to get script() past its first race()
// point: goTo()/faceTowards() return promises that never settle on their
// own, so the only way script() moves past them is cancellation — which is
// exactly the thing under test.

import { afterEach, describe, expect, it, vi } from 'vitest'
import * as THREE from 'three'
import { runDemo } from '../src/office/demo.js'

function stubDocument() {
  const ctx2d = new Proxy({}, { get: () => () => {}, set: () => true })
  globalThis.document = {
    createElement: () => ({ width: 0, height: 0, getContext: () => ctx2d }),
  } as any
}

afterEach(() => {
  delete (globalThis as any).document
  vi.useRealTimers()
})

function makeCtx() {
  const agentSay = vi.fn() // agent's own speech-bubble text — distinct from the script's onBeat narration
  const onBeat = vi.fn()
  const focus = vi.fn()
  // Captured so a test can prove an unregistered/raw promise is NOT
  // touched by cancel() — only what went through race() is.
  const rawGoTo: Record<string, Promise<unknown>> = {}
  const agents = Array.from({ length: 5 }, (_, i) => {
    const id = `a${i + 1}`
    return {
      id, pos: { x: 0, z: 0 }, yaw: 0, busy: false,
      stop: vi.fn(), say: agentSay, setState: vi.fn(), act: vi.fn(),
      goTo() {
        const p = new Promise(() => {}) // never settles on its own
        rawGoTo[id] = p
        return p
      },
      faceTowards() { return new Promise(() => {}) },
    }
  })
  const ctx = {
    agents,
    world: { highfive: () => null }, // keeps waitForEncounter on its Promise.resolve() path
    tortoise: new THREE.Object3D(),
    scene: new THREE.Scene(),
    caption: vi.fn(),
    focus,
    zoneUI: { highlight: vi.fn() },
    onBeat,
  }
  return { ctx, agentSay, onBeat, focus, rawGoTo }
}

describe('demo.js cancellation core', () => {
  it('wait() resolves on schedule: the first beat lands after its timer fires', async () => {
    stubDocument()
    vi.useFakeTimers()
    const { ctx, onBeat } = makeCtx()
    runDemo(ctx)
    expect(onBeat).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(700)
    expect(onBeat).toHaveBeenCalledWith('Two agents open the same file. They share a desk and get on with it.')
  })

  it('cancel() during a race()-wrapped await settles the demo, but leaves the raw promise untouched', async () => {
    stubDocument()
    vi.useFakeTimers()
    const { ctx, rawGoTo } = makeCtx()
    const demo = runDemo(ctx)
    await vi.advanceTimersByTimeAsync(700) // past the reset beat, into the first race(Promise.all([...goTo]))
    expect(rawGoTo.a1).toBeDefined()

    let rawSettled = false
    rawGoTo.a1.then(() => { rawSettled = true }, () => { rawSettled = true })

    demo.cancel()
    await expect(demo.promise).resolves.toBe('cancelled')

    // Flush microtasks/timers again — if the raw goTo promise were ever
    // going to settle because of cancel(), it would have by now. It
    // wasn't registered with tok.rejects, so it just hangs, same as any
    // beat that forgets to wrap its await in race().
    await vi.advanceTimersByTimeAsync(0)
    expect(rawSettled).toBe(false)
  })

  it('cancel() clears every pending timer — nothing fires after', async () => {
    stubDocument()
    vi.useFakeTimers()
    const { ctx, agentSay, onBeat } = makeCtx()
    const demo = runDemo(ctx)
    await vi.advanceTimersByTimeAsync(700)
    agentSay.mockClear()
    onBeat.mockClear()

    demo.cancel()
    expect(vi.getTimerCount()).toBe(0)

    await vi.advanceTimersByTimeAsync(60_000)
    expect(agentSay).not.toHaveBeenCalled()
    expect(onBeat).not.toHaveBeenCalled()
  })

  it('cancel() before the initial reset wait ever fires still settles the demo', async () => {
    // #160: wait(700, tok) at the top of script() used to be a bare wait(),
    // not wrapped in race(). cancel() clears its setTimeout before it can
    // fire, so its only settle path (the timeout callback) never ran — the
    // promise, and script() suspended on it, just hung. Now every wait()
    // goes through race(_, tok) same as the rest of script(), so cancel()
    // rejects it via tok.rejects like anything else.
    stubDocument()
    vi.useFakeTimers()
    const { ctx } = makeCtx()
    const demo = runDemo(ctx)
    demo.cancel() // cancel before the initial 700ms reset wait ever fires

    await expect(demo.promise).resolves.toBe('cancelled')
  })

  it('double cancel is safe', async () => {
    stubDocument()
    vi.useFakeTimers()
    const { ctx } = makeCtx()
    const demo = runDemo(ctx)
    await vi.advanceTimersByTimeAsync(700)
    expect(() => { demo.cancel(); demo.cancel() }).not.toThrow()
    await expect(demo.promise).resolves.toBe('cancelled')
  })
})
