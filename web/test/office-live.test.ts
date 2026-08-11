import { describe, it, expect, afterEach } from 'vitest'
import { LiveDirector, PRESENCE_TTL_MS, hairFor, connect } from '../src/office/live.js'
import { HAIR_COLORS } from '../src/palette.js'

function presence(agent: string, human: string, verb = 'edit', path = 'src/a.ts', rung = 0) {
  return { type: 'presence', agent, human, verb, region: { path }, rung }
}

describe('LiveDirector', () => {
  it('spawns on first sight and not again', () => {
    const d = new LiveDirector()
    expect(d.onPresence(presence('a1', 'sara'), 0).spawned).toBe(true)
    expect(d.onPresence(presence('a1', 'sara'), 1).spawned).toBe(false)
  })

  it('routes a real verb/path through zones.js, not a script', () => {
    const d = new LiveDirector()
    expect(d.onPresence(presence('a1', 'sara', 'edit', 'src/auth/session.ts'), 0).zone).toBe('vault')
    expect(d.onPresence(presence('a1', 'sara', 'edit', 'package.json'), 0).zone).toBe('cables')
  })

  it('expires an agent that has gone quiet past the TTL', () => {
    const d = new LiveDirector()
    d.onPresence(presence('a1', 'sara'), 0)
    expect(d.expire(PRESENCE_TTL_MS - 1)).toEqual([])
    expect(d.has('a1')).toBe(true)
    expect(d.expire(PRESENCE_TTL_MS + 1)).toEqual(['a1'])
    expect(d.has('a1')).toBe(false)
  })

  it('shares a slot for two agents editing the same path — rung 0 co-location', () => {
    const d = new LiveDirector()
    d.onPresence(presence('a1', 'sara', 'read', 'src/orders/total.ts'), 0)
    const info = d.onPresence(presence('a2', 'dev', 'read', 'src/orders/total.ts'), 0)
    expect(info.shareWith).toBe('a1')
  })

  it('clusters by human even on different paths', () => {
    const d = new LiveDirector()
    d.onPresence(presence('a1', 'sara', 'edit', 'src/one.ts'), 0)
    const info = d.onPresence(presence('a2', 'sara', 'edit', 'src/two.ts'), 0)
    expect(info.shareWith).toBe('a1')
  })

  it('does not share across two unrelated agents', () => {
    const d = new LiveDirector()
    d.onPresence(presence('a1', 'sara', 'edit', 'src/one.ts'), 0)
    const info = d.onPresence(presence('a2', 'dev', 'edit', 'src/two.ts'), 0)
    expect(info.shareWith).toBeNull()
  })

  it('flags rung 3 as a contest against the peer on the same path', () => {
    const d = new LiveDirector()
    d.onPresence(presence('a1', 'sara', 'edit', 'src/order.ts', 0), 0)
    const info = d.onPresence(presence('a2', 'dev', 'edit', 'src/order.ts', 3), 0)
    expect(info.contestWith).toBe('a1')
  })

  it('does not contest a peer on a different path even at rung 3', () => {
    const d = new LiveDirector()
    d.onPresence(presence('a1', 'sara', 'edit', 'src/order.ts', 0), 0)
    const info = d.onPresence(presence('a2', 'dev', 'edit', 'src/other.ts', 3), 0)
    expect(info.contestWith).toBeNull()
  })

  it('ignores a peer that has already expired when looking for a contest', () => {
    const d = new LiveDirector()
    d.onPresence(presence('a1', 'sara', 'edit', 'src/order.ts', 0), 0)
    const info = d.onPresence(presence('a2', 'dev', 'edit', 'src/order.ts', 3), PRESENCE_TTL_MS + 1)
    expect(info.contestWith).toBeNull()
  })

  it('tracks and clears a contest from either side', () => {
    const d = new LiveDirector()
    d.markContest('a1', 'a2')
    expect(d.contestPartner('a1')).toBe('a2')
    expect(d.contestPartner('a2')).toBe('a1')
    expect(d.clearContest('a1')).toBe('a2')
    expect(d.contestPartner('a1')).toBeNull()
    expect(d.contestPartner('a2')).toBeNull()
  })

  it('clearContest on an agent with no contest is a no-op', () => {
    const d = new LiveDirector()
    expect(d.clearContest('nobody')).toBeNull()
  })
})

describe('hairFor', () => {
  it('is stable per human and drawn from the six-colour palette', () => {
    expect(hairFor('sara')).toBe(hairFor('sara'))
    expect(HAIR_COLORS.map(h => parseInt(h.slice(1), 16))).toContain(hairFor('sara'))
  })

  it('matches web/src/palette.ts hairFor exactly, human for human', () => {
    // office/*.js cannot import the .ts side (no bundler in that path), so
    // live.js keeps its own copy of the hash and the palette. This is the
    // regression test for that copy staying in sync.
    const toHex = (s: string) => parseInt(s.slice(1), 16)
    const tsHairFor = (human: string) => {
      let h = 0
      for (let i = 0; i < human.length; i++) h = (h * 31 + human.charCodeAt(i)) >>> 0
      return HAIR_COLORS[h % HAIR_COLORS.length]
    }
    for (const human of ['sara', 'dev', 'ali', 'kim', '', 'a-very-long-human-name-here']) {
      expect(hairFor(human)).toBe(toHex(tsHairFor(human)))
    }
  })
})

// Stands in for a browser WebSocket: `connect()` only ever calls `send` and
// `close`, and only ever reads `onopen`/`onmessage`/`onerror`/`onclose`.
class FakeSocket {
  static last: FakeSocket | undefined
  sent: string[] = []
  onopen: (() => void) | null = null
  onmessage: ((e: { data: string }) => void) | null = null
  onerror: (() => void) | null = null
  onclose: (() => void) | null = null
  constructor(public url: string) { FakeSocket.last = this }
  send(data: string) { this.sent.push(data) }
  close() {}
}

describe('connect', () => {
  const origWebSocket = globalThis.WebSocket
  afterEach(() => { globalThis.WebSocket = origWebSocket })

  it('feeds the join snapshot presence array through onPresence, entry by entry', () => {
    globalThis.WebSocket = FakeSocket as unknown as typeof WebSocket
    const seen: any[] = []
    const conn = connect({ room: 'r1', human: 'sara', onPresence: (m) => seen.push(m) })
    const sock = FakeSocket.last!
    sock.onmessage!({
      data: JSON.stringify({
        type: 'leases',
        leases: [],
        presence: [
          { agent: 'a1', human: 'sara', verb: 'edit', region: { path: 'src/a.ts' }, ts: 1000 },
          { agent: 'a2', human: 'dev', verb: 'read', region: { path: 'src/b.ts' }, ts: 1001 },
        ],
      }),
    })
    expect(seen).toHaveLength(2)
    expect(seen[0]).toMatchObject({ agent: 'a1', human: 'sara', verb: 'edit' })
    expect(seen[1]).toMatchObject({ agent: 'a2', human: 'dev', verb: 'read' })
    conn.close()
  })

  it('ignores a leases frame with no presence array, and a malformed entry inside one', () => {
    globalThis.WebSocket = FakeSocket as unknown as typeof WebSocket
    const seen: any[] = []
    const conn = connect({ room: 'r1', human: 'sara', onPresence: (m) => seen.push(m) })
    const sock = FakeSocket.last!
    sock.onmessage!({ data: JSON.stringify({ type: 'leases', leases: [] }) })
    sock.onmessage!({
      data: JSON.stringify({ type: 'leases', leases: [], presence: [{ agent: 'a1' }] }),
    })
    expect(seen).toHaveLength(0)
    conn.close()
  })
})
