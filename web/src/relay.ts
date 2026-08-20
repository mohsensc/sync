// The capsule viewer's half of live.js's connect/connectWithReconnect —
// re-hosted here for the TS side the same way live.js's own header
// describes itself as "subscribe.ts's idea, re-hosted... in plain JS" for
// the untyped one. Not imported from live.js: its connect() only exposes
// onPresence/onDecision/onRedundant, already unwrapping a "leases" join
// reply into individual presence frames before the callback fires — which
// would make subscribe.ts's own handling of that frame (see its onMessage)
// unreachable on this path. This keeps every raw frame intact instead.
//
// Split out of main.ts (rather than inlined) so it's importable by a test
// the same way office-live-reconnect.test.ts drives live.js's version:
// main.ts has DOM side effects at import time (getElementById,
// requestAnimationFrame) that a plain vitest environment can't run.
export const RECONNECT_BASE_MS = 1_000
export const RECONNECT_MAX_MS = 30_000

export function reconnectDelayMs(attempt: number, base = RECONNECT_BASE_MS, cap = RECONNECT_MAX_MS): number {
  return Math.min(cap, base * 2 ** Math.max(0, attempt))
}

export interface ConnectFramesOptions {
  url: string
  room: string
  human: string
  onFrame: (msg: unknown) => void
}

/**
 * Opens a websocket to the relay, joins a room, and reconnects with
 * exponential backoff (capped, never gives up) whenever the connection
 * drops — including a graceful 1001 close, which used to freeze the page
 * for good since there was no onclose here at all. Every parsed frame goes
 * to onFrame verbatim; callers that need type-specific handling (leases,
 * presence, ...) do it downstream, same as subscribe.ts's Subscription.
 */
export function connectWithFrames({ url, room, human, onFrame }: ConnectFramesOptions): { close(): void } {
  let attempt = 0
  let stopped = false
  let timer: ReturnType<typeof setTimeout> | null = null
  let ws: WebSocket | null = null

  function scheduleReconnect(): void {
    if (stopped) return
    const delay = reconnectDelayMs(attempt)
    attempt++
    timer = setTimeout(open, delay)
  }

  function open(): void {
    try {
      ws = new WebSocket(url)
    } catch {
      // Constructor threw synchronously (bad URL, etc) — no socket, no
      // onclose to react to it, so schedule the retry ourselves. Mirrors
      // live.js's connect(), which does the same for the same reason.
      scheduleReconnect()
      return
    }
    ws.onopen = () => {
      attempt = 0
      ws!.send(JSON.stringify({ type: 'join', room, agent: 'viewer', human }))
    }
    ws.onmessage = (e) => {
      try {
        onFrame(JSON.parse(e.data))
      } catch {
        // A bad frame must never blank the world.
      }
    }
    // onerror carries nothing actionable of its own; onclose fires right
    // after it either way, so onclose is the one place that needs to react.
    ws.onerror = () => {}
    ws.onclose = () => scheduleReconnect()
  }
  open()

  return {
    close() {
      stopped = true
      if (timer != null) clearTimeout(timer)
      try {
        ws?.close()
      } catch {
        // already gone
      }
    },
  }
}
