// live.js's onClose used to be a dead end: once the relay hung up, the
// office was in demo mode for the rest of the page's life, even if the
// relay came back a second later. connectWithReconnect is the fix — see
// office.html's initLive, which now wraps Live.connect() with this instead
// of calling it directly.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { connectWithReconnect, reconnectDelayMs, RECONNECT_BASE_MS, RECONNECT_MAX_MS } from '../src/office/live.js'

// Same stand-in as office-live.test.ts's FakeSocket, plus a close() that
// actually fires onclose — connectWithReconnect's own retry loop reacts to
// the close event, unlike connect() alone, so the fake has to round-trip it.
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

  it('caps instead of growing without bound — "do not retry forever at full speed" cuts both ways', () => {
    expect(reconnectDelayMs(10)).toBe(RECONNECT_MAX_MS)
    expect(reconnectDelayMs(1000)).toBe(RECONNECT_MAX_MS)
  })

  it('treats a negative attempt count the same as zero', () => {
    expect(reconnectDelayMs(-3)).toBe(RECONNECT_BASE_MS)
  })
})

describe('connectWithReconnect', () => {
  const origWebSocket = globalThis.WebSocket
  beforeEach(() => { FakeSocket.instances = []; vi.useFakeTimers() })
  afterEach(() => { globalThis.WebSocket = origWebSocket; vi.useRealTimers() })

  it('reopens a fresh socket on its own after the relay drops the connection', () => {
    globalThis.WebSocket = FakeSocket as unknown as typeof WebSocket
    const opens: number[] = []
    const closes: number[] = []
    const conn = connectWithReconnect({
      room: 'r1', human: 'sara',
      onOpen: () => opens.push(1),
      onClose: () => closes.push(1),
    })
    expect(FakeSocket.instances).toHaveLength(1)
    FakeSocket.instances[0].onopen!()
    expect(opens).toHaveLength(1)

    // relay goes away
    FakeSocket.instances[0].onclose!()
    expect(closes).toHaveLength(1)
    // not yet — still waiting out the backoff, no fresh attempt underway
    expect(FakeSocket.instances).toHaveLength(1)

    vi.advanceTimersByTime(RECONNECT_BASE_MS)
    expect(FakeSocket.instances).toHaveLength(2)
    FakeSocket.instances[1].onopen!()
    expect(opens).toHaveLength(2)

    conn.close()
  })

  it('grows the backoff on repeated misses and resets it on a successful open', () => {
    globalThis.WebSocket = FakeSocket as unknown as typeof WebSocket
    const conn = connectWithReconnect({ room: 'r1', human: 'sara' })

    FakeSocket.instances[0].onclose!()               // miss #1 -> next gap = base
    vi.advanceTimersByTime(RECONNECT_BASE_MS)
    expect(FakeSocket.instances).toHaveLength(2)

    FakeSocket.instances[1].onclose!()                // miss #2 -> next gap = base*2
    vi.advanceTimersByTime(RECONNECT_BASE_MS * 2 - 1)
    expect(FakeSocket.instances).toHaveLength(2)      // not yet, gap doubled
    vi.advanceTimersByTime(1)
    expect(FakeSocket.instances).toHaveLength(3)

    // a real open resets the counter back to the base delay
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
    const closes: number[] = []
    const conn = connectWithReconnect({ room: 'r1', human: 'sara', onClose: () => closes.push(1) })
    FakeSocket.instances[0].onclose!()
    expect(closes).toHaveLength(1)

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
    const opens: number[] = []
    const closes: number[] = []
    const conn = connectWithReconnect({
      room: 'r1', human: 'sara',
      onOpen: () => opens.push(1),
      onClose: () => closes.push(1),
    })
    // connect()'s own try/catch around `new WebSocket` fired onClose
    // synchronously, before this call even returned — no socket exists yet.
    expect(FakeSocket.instances).toHaveLength(0)
    expect(closes).toHaveLength(1)

    vi.advanceTimersByTime(RECONNECT_BASE_MS)
    expect(FakeSocket.instances).toHaveLength(1)
    FakeSocket.instances[0].onopen!()
    expect(opens).toHaveLength(1)

    conn.close()
  })
})
