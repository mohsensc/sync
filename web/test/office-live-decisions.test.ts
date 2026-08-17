// The decision-frame half of live.js: onDecision/onRedundant, and the pure
// toReelEvent normalizer. Same no-DOM style as office-live.test.ts — a
// FakeSocket stands in for the browser WebSocket, connect() is exercised
// directly, presence behavior is untouched (office-live.test.ts already
// covers it; this file only adds the two new frame kinds).

import { describe, it, expect, afterEach } from 'vitest'
import { connect, toReelEvent, LiveDirector } from '../src/office/live.js'

function presence(agent: string, human: string, verb = 'edit', path = 'src/a.ts', rung = 3) {
  return { type: 'presence', agent, human, verb, region: { path }, rung }
}

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

function send(sock: FakeSocket, frame: unknown) {
  sock.onmessage!({ data: JSON.stringify(frame) })
}

describe('connect: decision and redundant frames', () => {
  const origWebSocket = globalThis.WebSocket
  afterEach(() => { globalThis.WebSocket = origWebSocket })

  function open(cfg: Partial<Parameters<typeof connect>[0]> = {}) {
    globalThis.WebSocket = FakeSocket as unknown as typeof WebSocket
    const decisions: any[] = []
    const redundants: any[] = []
    const presences: any[] = []
    const conn = connect({
      room: 'r1', human: 'sara',
      onPresence: (m) => presences.push(m),
      onDecision: (m) => decisions.push(m),
      onRedundant: (m) => redundants.push(m),
      ...cfg,
    })
    return { sock: FakeSocket.last!, decisions, redundants, presences, conn }
  }

  it('fires onDecision for a negotiate frame with a wait verdict', () => {
    const { sock, decisions } = open()
    send(sock, {
      type: 'negotiate', rung: 3, decision: 'wait',
      holder_agent: 'agent-2', holder_human: 'priya',
      priority: 'standard', holder_priority: 'standard',
    })
    expect(decisions).toHaveLength(1)
    expect(decisions[0]).toMatchObject({ type: 'negotiate', decision: 'wait' })
  })

  it('fires onDecision for a negotiate frame with an abort verdict', () => {
    const { sock, decisions } = open()
    send(sock, { type: 'negotiate', rung: 3, decision: 'abort', holder_agent: 'agent-1', holder_human: 'dev' })
    expect(decisions).toHaveLength(1)
    expect(decisions[0].decision).toBe('abort')
  })

  it('fires onDecision for a refused claim_result', () => {
    const { sock, decisions } = open()
    send(sock, {
      type: 'claim_result', granted: false, decision: 'abort',
      region: { path: 'src/order.ts' }, held_by: 'agent-3', human: 'dev',
    })
    expect(decisions).toHaveLength(1)
    expect(decisions[0]).toMatchObject({ type: 'claim_result', decision: 'abort' })
  })

  it('does not treat a granted claim_result as a decision — it has no decision field', () => {
    const { sock, decisions } = open()
    send(sock, { type: 'claim_result', granted: true, lease: 'x' })
    expect(decisions).toHaveLength(0)
  })

  it('drops a negotiate frame with a malformed decision value', () => {
    const { sock, decisions } = open()
    send(sock, { type: 'negotiate', decision: 'maybe' })
    expect(decisions).toHaveLength(0)
  })

  it('fires onRedundant for a well-formed redundant_work frame', () => {
    const { sock, redundants } = open()
    send(sock, {
      type: 'redundant_work', rung: 4, agent: 'agent-5', human: 'dev',
      intent: 'refactor totals', region: { path: 'src/orders/total.ts' }, score: 0.87,
    })
    expect(redundants).toHaveLength(1)
    expect(redundants[0]).toMatchObject({ agent: 'agent-5', human: 'dev', score: 0.87 })
  })

  it('drops a redundant_work frame missing a region path', () => {
    const { sock, redundants } = open()
    send(sock, { type: 'redundant_work', agent: 'agent-5', human: 'dev', intent: 'x', score: 0.9 })
    expect(redundants).toHaveLength(0)
  })

  it('drops a redundant_work frame with a non-numeric score', () => {
    const { sock, redundants } = open()
    send(sock, {
      type: 'redundant_work', agent: 'agent-5', human: 'dev',
      intent: 'x', region: { path: 'a.ts' }, score: 'high',
    })
    expect(redundants).toHaveLength(0)
  })

  it('leaves the presence path alone: a presence frame never reaches onDecision or onRedundant', () => {
    const { sock, presences, decisions, redundants } = open()
    send(sock, { type: 'presence', agent: 'a1', human: 'sara', verb: 'edit', region: { path: 'a.ts' }, rung: 0 })
    expect(presences).toHaveLength(1)
    expect(decisions).toHaveLength(0)
    expect(redundants).toHaveLength(0)
  })

  it('a completely malformed frame reaches none of the three callbacks', () => {
    const { sock, presences, decisions, redundants } = open()
    send(sock, { type: 'negotiate' })
    send(sock, { garbage: true })
    send(sock, null)
    expect(presences).toHaveLength(0)
    expect(decisions).toHaveLength(0)
    expect(redundants).toHaveLength(0)
  })
})

describe('toReelEvent', () => {
  it('normalizes a negotiate/wait frame into a wait resolution', () => {
    const e = toReelEvent({
      type: 'negotiate', rung: 3, decision: 'wait',
      holder_agent: 'agent-2', holder_human: 'priya', holder_priority: 'standard',
    }, 5000)
    expect(e).toMatchObject({
      ts: 5000, rung: 3,
      b: { agent: 'agent-2', human: 'priya' },
      resolution: { kind: 'wait' },
      source: 'live',
    })
    expect(typeof e!.id).toBe('string')
    expect(e!.id.length).toBeGreaterThan(0)
  })

  it('normalizes a negotiate/abort frame into an abort resolution', () => {
    const e = toReelEvent({ type: 'negotiate', rung: 3, decision: 'abort', holder_agent: 'agent-4', holder_human: 'sara' }, 1)
    expect(e!.resolution).toMatchObject({ kind: 'abort' })
  })

  it('defaults rung to 3 for a claim_result, which never carries one', () => {
    const e = toReelEvent({
      type: 'claim_result', granted: false, decision: 'abort',
      region: { path: 'src/order.ts' }, held_by: 'agent-3', human: 'dev',
    }, 10)
    expect(e!.rung).toBe(3)
    expect(e!.path).toBe('src/order.ts')
    expect(e!.b).toMatchObject({ agent: 'agent-3', human: 'dev' })
  })

  it('leaves the requester side blank rather than inventing an identity', () => {
    const e = toReelEvent({ type: 'negotiate', rung: 3, decision: 'wait', holder_agent: 'agent-2', holder_human: 'priya' }, 1)
    expect(e!.a).toEqual({ agent: '', human: '' })
  })

  it('normalizes redundant_work into a redundant resolution at rung 4', () => {
    const e = toReelEvent({
      type: 'redundant_work', agent: 'agent-5', human: 'dev',
      intent: 'refactor totals', region: { path: 'src/orders/total.ts' }, score: 0.87,
    }, 20)
    expect(e).toMatchObject({
      ts: 20, rung: 4,
      a: { agent: 'agent-5', human: 'dev' },
      b: { agent: '', human: '' },
      path: 'src/orders/total.ts',
      resolution: { kind: 'redundant' },
      source: 'live',
    })
  })

  it('returns null for a frame it does not recognize', () => {
    expect(toReelEvent({ type: 'ack', rung: 0 })).toBeNull()
    expect(toReelEvent(null as any)).toBeNull()
    expect(toReelEvent({ type: 'negotiate', decision: 'maybe' })).toBeNull()
  })

  it('produces distinct ids for successive calls', () => {
    const a = toReelEvent({ type: 'negotiate', rung: 3, decision: 'wait', holder_agent: 'x', holder_human: 'y' }, 1)
    const b = toReelEvent({ type: 'negotiate', rung: 3, decision: 'wait', holder_agent: 'x', holder_human: 'y' }, 1)
    expect(a!.id).not.toBe(b!.id)
  })

  it('fills in a known requester on the a side instead of leaving it blank', () => {
    const e = toReelEvent(
      { type: 'negotiate', rung: 3, decision: 'wait', holder_agent: 'agent-2', holder_human: 'priya' },
      1,
      { agent: 'agent-1', human: 'sara' },
    )
    expect(e!.a).toEqual({ agent: 'agent-1', human: 'sara' })
    expect(e!.b).toEqual({ agent: 'agent-2', human: 'priya' })
  })

  it('a requester with no known human still fills the agent id, human stays blank', () => {
    const e = toReelEvent(
      { type: 'negotiate', rung: 3, decision: 'abort', holder_agent: 'agent-2', holder_human: 'priya' },
      1,
      { agent: 'agent-1', human: '' },
    )
    expect(e!.a).toEqual({ agent: 'agent-1', human: '' })
  })

  it('an empty-agent requester is treated the same as none — stays blank', () => {
    const e = toReelEvent(
      { type: 'negotiate', rung: 3, decision: 'wait', holder_agent: 'agent-2', holder_human: 'priya' },
      1,
      { agent: '', human: 'sara' },
    )
    expect(e!.a).toEqual({ agent: '', human: '' })
  })

  it('a requester has no effect on redundant_work, which already names both sides', () => {
    const e = toReelEvent(
      {
        type: 'redundant_work', agent: 'agent-5', human: 'dev',
        intent: 'x', region: { path: 'a.ts' }, score: 0.5,
      },
      1,
      { agent: 'someone-else', human: 'nope' },
    )
    expect(e!.a).toEqual({ agent: 'agent-5', human: 'dev' })
  })
})

// #60: client-side bookkeeping that matches a decision frame back to a
// tracked live contest pair, since the wire never says who "self" is on
// negotiate/claim_result. See LiveDirector.resolutionFor's own comment.
describe('LiveDirector.resolutionFor', () => {
  it('tracks an active pair on markContest, keyed by both ids', () => {
    const d = new LiveDirector()
    d.onPresence(presence('a1', 'sara', 'edit', 'src/x.ts'), 0)
    d.onPresence(presence('a2', 'priya', 'edit', 'src/x.ts'), 0)
    d.markContest('a1', 'a2')
    expect(d.contestPairs.get('a1')).toMatchObject({ path: 'src/x.ts', aId: 'a1', bId: 'a2' })
    expect(d.contestPairs.get('a2')).toBe(d.contestPairs.get('a1'))
  })

  it('matches a wait decision by holder_agent identity', () => {
    const d = new LiveDirector()
    d.onPresence(presence('a1', 'sara', 'edit', 'src/x.ts'), 0)
    d.onPresence(presence('a2', 'priya', 'edit', 'src/x.ts'), 0)
    d.markContest('a1', 'a2')
    const res = d.resolutionFor({
      type: 'negotiate', decision: 'wait', holder_agent: 'a2', holder_human: 'priya',
      region: { path: 'src/x.ts' },
    })
    expect(res).toEqual({ winnerId: 'a2', loserId: 'a1', kind: 'wait' })
  })

  it('matches an abort decision by holder_agent, winner/loser swap the other way', () => {
    const d = new LiveDirector()
    d.onPresence(presence('a1', 'sara', 'edit', 'src/x.ts'), 0)
    d.onPresence(presence('a2', 'priya', 'edit', 'src/x.ts'), 0)
    d.markContest('a1', 'a2')
    const res = d.resolutionFor({
      type: 'negotiate', decision: 'abort', holder_agent: 'a1', holder_human: 'sara',
    })
    expect(res).toEqual({ winnerId: 'a1', loserId: 'a2', kind: 'abort' })
  })

  it('matches a claim_result by held_by when holder_agent is absent', () => {
    const d = new LiveDirector()
    d.onPresence(presence('a1', 'sara', 'edit', 'src/x.ts'), 0)
    d.onPresence(presence('a2', 'priya', 'edit', 'src/x.ts'), 0)
    d.markContest('a1', 'a2')
    const res = d.resolutionFor({
      type: 'claim_result', decision: 'abort', held_by: 'a2', human: 'priya',
      region: { path: 'src/x.ts' },
    })
    expect(res).toEqual({ winnerId: 'a2', loserId: 'a1', kind: 'abort' })
  })

  it('matches by handover_to when holder_agent does not name a tracked id', () => {
    const d = new LiveDirector()
    d.onPresence(presence('a1', 'sara', 'edit', 'src/x.ts'), 0)
    d.onPresence(presence('a2', 'priya', 'edit', 'src/x.ts'), 0)
    d.markContest('a1', 'a2')
    const res = d.resolutionFor({
      type: 'negotiate', decision: 'wait', holder_agent: 'someone-not-tracked', handover_to: 'a1',
    })
    expect(res).toEqual({ winnerId: 'a1', loserId: 'a2', kind: 'wait' })
  })

  it('returns null when neither holder_agent nor handover_to names a tracked id', () => {
    const d = new LiveDirector()
    d.onPresence(presence('a1', 'sara', 'edit', 'src/x.ts'), 0)
    d.onPresence(presence('a2', 'priya', 'edit', 'src/x.ts'), 0)
    d.markContest('a1', 'a2')
    const res = d.resolutionFor({ type: 'negotiate', decision: 'wait', holder_agent: 'agent-9' })
    expect(res).toBeNull()
  })

  it('returns null when there is no active contest tracked at all', () => {
    const d = new LiveDirector()
    const res = d.resolutionFor({ type: 'negotiate', decision: 'wait', holder_agent: 'a2' })
    expect(res).toBeNull()
  })

  it('returns null for a frame with no decision field (a granted claim_result)', () => {
    const d = new LiveDirector()
    d.onPresence(presence('a1', 'sara', 'edit', 'src/x.ts'), 0)
    d.onPresence(presence('a2', 'priya', 'edit', 'src/x.ts'), 0)
    d.markContest('a1', 'a2')
    const res = d.resolutionFor({ type: 'claim_result', granted: true, held_by: 'a2' })
    expect(res).toBeNull()
  })

  it('returns null when an identity match is contradicted by a mismatched path', () => {
    const d = new LiveDirector()
    d.onPresence(presence('a1', 'sara', 'edit', 'src/x.ts'), 0)
    d.onPresence(presence('a2', 'priya', 'edit', 'src/x.ts'), 0)
    d.markContest('a1', 'a2')
    const res = d.resolutionFor({
      type: 'negotiate', decision: 'wait', holder_agent: 'a2',
      region: { path: 'src/completely-different.ts' },
    })
    expect(res).toBeNull()
  })

  it('a stale pair is cleaned up once the contest clears, and no longer matches', () => {
    const d = new LiveDirector()
    d.onPresence(presence('a1', 'sara', 'edit', 'src/x.ts'), 0)
    d.onPresence(presence('a2', 'priya', 'edit', 'src/x.ts'), 0)
    d.markContest('a1', 'a2')
    d.clearContest('a1')
    expect(d.contestPairs.size).toBe(0)
    const res = d.resolutionFor({ type: 'negotiate', decision: 'wait', holder_agent: 'a2' })
    expect(res).toBeNull()
  })

  it('humanOf returns the tracked human for a live agent id, and "" when unseen', () => {
    const d = new LiveDirector()
    d.onPresence(presence('a1', 'sara', 'edit', 'src/x.ts'), 0)
    expect(d.humanOf('a1')).toBe('sara')
    expect(d.humanOf('ghost')).toBe('')
  })

  it('only one contest is tracked at a time per agent — a second markContest replaces the pair', () => {
    const d = new LiveDirector()
    d.onPresence(presence('a1', 'sara', 'edit', 'src/x.ts'), 0)
    d.onPresence(presence('a2', 'priya', 'edit', 'src/x.ts'), 0)
    d.onPresence(presence('a3', 'dev', 'edit', 'src/y.ts'), 0)
    d.markContest('a1', 'a2')
    d.markContest('a1', 'a3')
    const res = d.resolutionFor({ type: 'negotiate', decision: 'wait', holder_agent: 'a3' })
    expect(res).toEqual({ winnerId: 'a3', loserId: 'a1', kind: 'wait' })
  })
})
