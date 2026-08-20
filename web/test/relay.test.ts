// Mirrors test/office-live-reconnect.test.ts's pattern for live.js's
// connectWithReconnect — same FakeSocket, same fake-timer assertions —
// against relay.ts's connectWithFrames, main.ts's half of the same idea.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { connectWithFrames, reconnectDelayMs, RECONNECT_BASE_MS, RECONNECT_MAX_MS } from '../src/relay.js'

class FakeSocket {
  static instances: FakeSocket[] = []
  sent: string[] = []
  onopen: (() => void) | null = null
  onmessage: ((e: { data: string }) => void) | null = null
  onerror: (() => void) | null = null
  onclose: (() => void) | null = null
  constructor(public url: string) { FakeSocket.instances.push(this) }
  send(data: string) { this.sent.push(data) }
  close() { if (this.onclose) this.onclose() }
}

describe('reconnectDelayMs', () => {
  it('doubles per attempt starting from the base delay', () => {
    expect(reconnectDelayMs(0)).toBe(RECONNECT_BASE_MS)
    expect(reconnectDelayMs(1)).toBe(RECONNECT_BASE_MS * 2)
    expect(reconnectDelayMs(2)).toBe(RECONNECT_BASE_MS * 4)
  })

  it('caps instead of growing without bound', () => {
    expect(reconnectDelayMs(10)).toBe(RECONNECT_MAX_MS)
  })
})

describe('connectWithFrames', () => {
  const origWebSocket = globalThis.WebSocket
  beforeEach(() => { FakeSocket.instances = []; vi.useFakeTimers() })
  afterEach(() => { globalThis.WebSocket = origWebSocket; vi.useRealTimers() })

  it('sends one join frame on open, with room/agent/human', () => {
    globalThis.WebSocket = FakeSocket as unknown as typeof WebSocket
    const conn = connectWithFrames({ url: 'ws://x', room: 'r1', human: 'sara', onFrame: () => {} })
    FakeSocket.instances[0].onopen!()
    expect(FakeSocket.instances[0].sent).toEqual([
      JSON.stringify({ type: 'join', room: 'r1', agent: 'viewer', human: 'sara' }),
    ])
    conn.close()
  })

  it('forwards every parsed frame to onFrame, whatever its type', () => {
    globalThis.WebSocket = FakeSocket as unknown as typeof WebSocket
    const frames: unknown[] = []
    const conn = connectWithFrames({ url: 'ws://x', room: 'r1', human: 'sara', onFrame: (m) => frames.push(m) })
    FakeSocket.instances[0].onmessage!({ data: JSON.stringify({ type: 'leases', presence: [] }) })
    FakeSocket.instances[0].onmessage!({ data: JSON.stringify({ type: 'presence', agent: 'a1' }) })
    expect(frames).toEqual([{ type: 'leases', presence: [] }, { type: 'presence', agent: 'a1' }])
    conn.close()
  })

  it('a bad frame never throws out of onmessage', () => {
    globalThis.WebSocket = FakeSocket as unknown as typeof WebSocket
    const conn = connectWithFrames({ url: 'ws://x', room: 'r1', human: 'sara', onFrame: () => {} })
    expect(() => FakeSocket.instances[0].onmessage!({ data: 'not json' })).not.toThrow()
    conn.close()
  })

  it('reopens a fresh socket on its own after the relay drops the connection', () => {
    globalThis.WebSocket = FakeSocket as unknown as typeof WebSocket
    const conn = connectWithFrames({ url: 'ws://x', room: 'r1', human: 'sara', onFrame: () => {} })
    expect(FakeSocket.instances).toHaveLength(1)

    FakeSocket.instances[0].onclose!()
    expect(FakeSocket.instances).toHaveLength(1) // still waiting out the backoff

    vi.advanceTimersByTime(RECONNECT_BASE_MS)
    expect(FakeSocket.instances).toHaveLength(2)

    conn.close()
  })

  it('grows the backoff on repeated misses and resets it on a successful open', () => {
    globalThis.WebSocket = FakeSocket as unknown as typeof WebSocket
    const conn = connectWithFrames({ url: 'ws://x', room: 'r1', human: 'sara', onFrame: () => {} })

    FakeSocket.instances[0].onclose!()
    vi.advanceTimersByTime(RECONNECT_BASE_MS)
    expect(FakeSocket.instances).toHaveLength(2)

    FakeSocket.instances[1].onclose!()
    vi.advanceTimersByTime(RECONNECT_BASE_MS * 2 - 1)
    expect(FakeSocket.instances).toHaveLength(2)
    vi.advanceTimersByTime(1)
    expect(FakeSocket.instances).toHaveLength(3)

    FakeSocket.instances[2].onopen!()
    FakeSocket.instances[2].onclose!()
    vi.advanceTimersByTime(RECONNECT_BASE_MS - 1)
    expect(FakeSocket.instances).toHaveLength(3)
    vi.advanceTimersByTime(1)
    expect(FakeSocket.instances).toHaveLength(4)

    conn.close()
  })

  it('close() stops the loop for good: no further attempt, ever', () => {
    globalThis.WebSocket = FakeSocket as unknown as typeof WebSocket
    const conn = connectWithFrames({ url: 'ws://x', room: 'r1', human: 'sara', onFrame: () => {} })
    FakeSocket.instances[0].onclose!()
    conn.close()
    vi.advanceTimersByTime(RECONNECT_MAX_MS * 4)
    expect(FakeSocket.instances).toHaveLength(1)
  })

  it('keeps retrying even when the WebSocket constructor itself throws synchronously', () => {
    let calls = 0
    class ThrowsOnceSocket extends FakeSocket {
      constructor(url: string) {
        calls++
        if (calls === 1) throw new Error('nope')
        super(url)
      }
    }
    globalThis.WebSocket = ThrowsOnceSocket as unknown as typeof WebSocket
    const conn = connectWithFrames({ url: 'ws://x', room: 'r1', human: 'sara', onFrame: () => {} })
    expect(FakeSocket.instances).toHaveLength(0)

    vi.advanceTimersByTime(RECONNECT_BASE_MS)
    expect(FakeSocket.instances).toHaveLength(1)

    conn.close()
  })
})
