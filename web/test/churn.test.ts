import { describe, it, expect, vi } from 'vitest'
import { churnToIntensity, attachGitSignals, CHURN_MODES, staleToIntensity } from '../src/office/gitsignals.js'

describe('churnToIntensity', () => {
  it('returns null on ok:false, missing body, or a body missing both recent and working', () => {
    expect(churnToIntensity({ ok: false, reason: 'not a tracked path' })).toBe(null)
    expect(churnToIntensity(null)).toBe(null)
    expect(churnToIntensity(undefined)).toBe(null)
    expect(churnToIntensity({ ok: true })).toBe(null)
  })

  it('is 0 for a file with no recent or working-tree activity', () => {
    const quiet = {
      ok: true,
      recent: { commits: 0, added: 0, deleted: 0, windowDays: 14 },
      working: { added: 0, deleted: 0 },
    }
    expect(churnToIntensity(quiet)).toBe(0)
  })

  it('weighs uncommitted working-tree churn heavier than 14-day history', () => {
    const recentOnly = {
      ok: true,
      recent: { commits: 3, added: 40, deleted: 10, windowDays: 14 },
      working: { added: 0, deleted: 0 },
    }
    const workingOnly = {
      ok: true,
      recent: { commits: 0, added: 0, deleted: 0, windowDays: 14 },
      working: { added: 40, deleted: 10 },
    }
    expect(churnToIntensity(workingOnly)!).toBeGreaterThan(churnToIntensity(recentOnly)!)
  })

  it('increases monotonically with more churn and never reaches 1', () => {
    const small = churnToIntensity({
      ok: true, recent: { commits: 1, added: 5, deleted: 0, windowDays: 14 }, working: { added: 0, deleted: 0 },
    })!
    const big = churnToIntensity({
      ok: true, recent: { commits: 10, added: 200, deleted: 100, windowDays: 14 }, working: { added: 100, deleted: 20 },
    })!
    expect(small).toBeGreaterThan(0)
    expect(big).toBeGreaterThan(small)
    expect(big).toBeLessThan(1)
  })

  it('treats a non-numeric added/deleted as 0 rather than NaN', () => {
    // gitapi.mjs's churn route is documented to turn numstat's "-" (its
    // marker for a binary file) into 0 before this ever sees it — this is
    // the defensive fallback for that contract not holding, e.g. a stale
    // endpoint that still sends the raw "-" through.
    const malformed = {
      ok: true,
      recent: { commits: 0, added: '-' as unknown as number, deleted: 0, windowDays: 14 },
      working: { added: 0, deleted: 0 },
    }
    expect(churnToIntensity(malformed)).toBe(0)
  })
})

// -- attachGitSignals: the churn poll's fold onto agents --------------------

function stubResponse(body: unknown, ok = true): Response {
  return { ok, json: async () => body } as unknown as Response
}

type FetchStub = (input: URL | RequestInfo, init?: RequestInit) => Promise<Response>

describe('attachGitSignals churn wiring', () => {
  it('calls setChurn with a real intensity for agents with a gitPath', async () => {
    const setChurn = vi.fn()
    const world = { agents: [{ gitPath: 'web/src/office/anim.js', setFreshness: vi.fn(), setChurn }] }
    const zones = { setOwner: vi.fn() }
    const fetchFn: FetchStub = vi.fn(async (input) => {
      const url = String(input)
      if (url.includes('/api/git/churn')) {
        return stubResponse({
          ok: true,
          recent: { commits: 2, added: 10, deleted: 4, windowDays: 14 },
          working: { added: 0, deleted: 0 },
        })
      }
      return stubResponse(null, false)
    })
    const s = attachGitSignals({ world, zones, fetchFn, intervalMs: 999999 })
    await s.tick()
    // attachGitSignals fires its own tick() on construction as well as the
    // one this test awaits, so this can land once or twice depending on
    // timing — the count isn't the point, a real positive intensity is.
    expect(setChurn).toHaveBeenCalled()
    expect(setChurn.mock.calls.every(c => c[0] > 0)).toBe(true)
    s.stop()
  })

  it('degrades to a no-op when the churn route is not up yet (404 / ok:false) — the build-before-task-1 case', async () => {
    const setChurn = vi.fn()
    const world = { agents: [{ gitPath: 'x', setFreshness: vi.fn(), setChurn }] }
    const zones = { setOwner: vi.fn() }
    const fetchFn: FetchStub = vi.fn(async () => stubResponse(null, false))
    const s = attachGitSignals({ world, zones, fetchFn, intervalMs: 999999 })
    await s.tick()
    expect(setChurn).not.toHaveBeenCalled()
    s.stop()
  })

  it('never throws when fetchFn rejects for the churn endpoint', async () => {
    const setChurn = vi.fn()
    const world = { agents: [{ gitPath: 'x', setFreshness: vi.fn(), setChurn }] }
    const zones = { setOwner: vi.fn() }
    const fetchFn: FetchStub = vi.fn(async () => { throw new Error('ECONNREFUSED') })
    const s = attachGitSignals({ world, zones, fetchFn, intervalMs: 999999 })
    await expect(s.tick()).resolves.toBeUndefined()
    expect(setChurn).not.toHaveBeenCalled()
    s.stop()
  })

  it('skips agents with no gitPath entirely', async () => {
    const setChurn = vi.fn()
    const world = { agents: [{ setFreshness: vi.fn(), setChurn }] }
    const zones = { setOwner: vi.fn() }
    const fetchFn: FetchStub = vi.fn(async () => stubResponse({ ok: true, recent: { commits: 1, added: 1, deleted: 0, windowDays: 14 }, working: { added: 0, deleted: 0 } }))
    const s = attachGitSignals({ world, zones, fetchFn, intervalMs: 999999 })
    await s.tick()
    expect(setChurn).not.toHaveBeenCalled()
    s.stop()
  })
})

// -- CHURN_MODES / staleToIntensity — the 'C'-key churn treatments --------

describe('CHURN_MODES', () => {
  it('cycles stack -> heat -> cold', () => {
    expect(CHURN_MODES).toEqual(['stack', 'heat', 'cold'])
  })
})

describe('staleToIntensity', () => {
  it('is 0 below the fresh floor and for no signal', () => {
    expect(staleToIntensity(0)).toBe(0)
    expect(staleToIntensity(60)).toBe(0)
    expect(staleToIntensity(null)).toBe(0)
    expect(staleToIntensity(undefined)).toBe(0)
    expect(staleToIntensity(NaN)).toBe(0)
    expect(staleToIntensity(-5)).toBe(0)
  })

  it('is 1 at and beyond the ancient ceiling', () => {
    expect(staleToIntensity(365)).toBe(1)
    expect(staleToIntensity(4000)).toBe(1)
  })

  it('ramps linearly between the floor and the ceiling', () => {
    expect(staleToIntensity(212.5)).toBeCloseTo(0.5, 5) // midpoint of 60..365
  })
})

// -- churn-vis: the 'heat'/'cold' desk treatments, cycled by setChurnMode --
// (the browser owns the 'C' keypress itself; this is the wiring it drives)

function fakeRoot() {
  const children: unknown[] = []
  return { add: (...o: unknown[]) => { children.push(...o) }, remove: vi.fn(), children }
}

describe('attachGitSignals churn-vis mode', () => {
  it('defaults to stack mode', () => {
    const world = { agents: [] }
    const zones = { setOwner: vi.fn() }
    const s = attachGitSignals({ world, zones, fetchFn: vi.fn(async () => stubResponse(null, false)), intervalMs: 999999 })
    expect(s.churnMode).toBe('stack')
    s.stop()
  })

  it('ignores an unrecognised mode rather than clearing the current one', () => {
    const world = { agents: [] }
    const zones = { setOwner: vi.fn() }
    const s = attachGitSignals({ world, zones, fetchFn: vi.fn(async () => stubResponse(null, false)), intervalMs: 999999 })
    s.setChurnMode('bogus' as never)
    expect(s.churnMode).toBe('stack')
    s.stop()
  })

  it('stops routing to setChurn once switched to heat, and attaches desk-fx onto agent.root', async () => {
    const setChurn = vi.fn()
    const root = fakeRoot()
    const world = { agents: [{ gitPath: 'web/src/office/anim.js', setFreshness: vi.fn(), setChurn, root, scale: 1 }] }
    const zones = { setOwner: vi.fn() }
    const fetchFn: FetchStub = vi.fn(async (input) => {
      const url = String(input)
      if (url.includes('/api/git/churn')) {
        return stubResponse({
          ok: true,
          recent: { commits: 5, added: 40, deleted: 10, windowDays: 14 },
          working: { added: 20, deleted: 5 },
        })
      }
      return stubResponse(null, false)
    })
    const s = attachGitSignals({ world, zones, fetchFn, intervalMs: 999999 })
    await s.tick()
    expect(setChurn).toHaveBeenCalled() // stack mode, same as the existing wiring test above

    setChurn.mockClear()
    s.setChurnMode('heat')
    expect(s.churnMode).toBe('heat')
    await s.tick()
    expect(setChurn).not.toHaveBeenCalled()
    // deskHeat + deskDust both attach a group onto the agent's root the
    // first time it's polled, regardless of which mode ends up visible.
    expect(root.children.length).toBe(2)
    s.stop()
  })

  it('never builds desk-fx, and never throws, for agents with no root (every pre-existing test fixture)', async () => {
    const setChurn = vi.fn()
    const world = { agents: [{ gitPath: 'x', setFreshness: vi.fn(), setChurn }] }
    const zones = { setOwner: vi.fn() }
    const fetchFn: FetchStub = vi.fn(async () => stubResponse({
      ok: true, recent: { commits: 1, added: 1, deleted: 0, windowDays: 14 }, working: { added: 0, deleted: 0 },
    }))
    const s = attachGitSignals({ world, zones, fetchFn, intervalMs: 999999 })
    s.setChurnMode('cold')
    await expect(s.tick()).resolves.toBeUndefined()
    s.stop()
  })
})
