import { describe, it, expect, vi } from 'vitest'
import { freshnessBucket } from '../src/office/agent.js'
import {
  ZONE_DIRS, statToAgeDays, shortlogToOwner, attachGitSignals,
} from '../src/office/gitsignals.js'

describe('freshnessBucket', () => {
  it('buckets null/undefined/NaN as no signal', () => {
    expect(freshnessBucket(null)).toBe(null)
    expect(freshnessBucket(undefined)).toBe(null)
    expect(freshnessBucket(NaN)).toBe(null)
    expect(freshnessBucket(-1)).toBe(null)
  })

  it('buckets by age in days', () => {
    expect(freshnessBucket(0)).toBe('fresh')
    expect(freshnessBucket(1.9)).toBe('fresh')
    expect(freshnessBucket(2)).toBe('warm')
    expect(freshnessBucket(20)).toBe('warm')
    expect(freshnessBucket(21)).toBe('normal')
    expect(freshnessBucket(179)).toBe('normal')
    expect(freshnessBucket(180)).toBe('stale')
    expect(freshnessBucket(4000)).toBe('stale')
  })
})

describe('ZONE_DIRS', () => {
  it('maps to plausible repo directories', () => {
    expect(ZONE_DIRS.desks).toBe('web/src')
    expect(ZONE_DIRS.vault).toBe('go')
    expect(ZONE_DIRS.whiteboard).toBe('web/src/office')
  })
})

describe('statToAgeDays', () => {
  it('reads lastAgeDays out of an ok stat response', () => {
    expect(statToAgeDays({ ok: true, lastAgeDays: 3 })).toBe(3)
  })
  it('returns null on ok:false, missing field, or garbage', () => {
    expect(statToAgeDays({ ok: false, reason: 'no such path' })).toBe(null)
    expect(statToAgeDays({ ok: true })).toBe(null)
    expect(statToAgeDays(null)).toBe(null)
    expect(statToAgeDays({ ok: true, lastAgeDays: 'yesterday' as unknown as number })).toBe(null)
  })
})

describe('shortlogToOwner', () => {
  it('picks the top author by commits', () => {
    const data = { ok: true, owners: [
      { author: 'sara', commits: 4, share: 0.3 },
      { author: 'mohsen', commits: 9, share: 0.7 },
    ] }
    expect(shortlogToOwner(data)).toBe('mohsen')
  })
  it('returns null on ok:false or an empty/missing owners list', () => {
    expect(shortlogToOwner({ ok: false })).toBe(null)
    expect(shortlogToOwner({ ok: true, owners: [] })).toBe(null)
    expect(shortlogToOwner({ ok: true })).toBe(null)
    expect(shortlogToOwner(null)).toBe(null)
  })
})

// -- attachGitSignals: the fold from fetchFn responses onto agents/zones ----

function stubResponse(body: unknown, ok = true): Response {
  return { ok, json: async () => body } as unknown as Response
}

type FetchStub = (input: URL | RequestInfo, init?: RequestInit) => Promise<Response>

describe('attachGitSignals', () => {
  it('calls setFreshness with the stat age for agents that have a gitPath', async () => {
    const setFreshness = vi.fn()
    const world = { agents: [{ gitPath: 'web/src/office/anim.js', setFreshness }] }
    const zones = { setOwner: vi.fn() }
    const fetchFn: FetchStub = vi.fn(async (input) => {
      const url = String(input)
      if (url.includes('/api/git/stat')) return stubResponse({ ok: true, lastAgeDays: 1 })
      if (url.includes('/api/git/shortlog')) return stubResponse({ ok: true, owners: [{ author: 'mohsen', commits: 5, share: 1 }] })
      return stubResponse(null, false)
    })
    const s = attachGitSignals({ world, zones, fetchFn, intervalMs: 999999 })
    await s.poll()
    expect(setFreshness).toHaveBeenCalledWith(1)
    s.stop()
  })

  it('clears freshness for agents with no gitPath, without fetching for them', async () => {
    const setFreshness = vi.fn()
    const world = { agents: [{ setFreshness }] }
    const zones = { setOwner: vi.fn() }
    const fetchFn: FetchStub = vi.fn(async () => stubResponse({ ok: true, lastAgeDays: 1 }))
    const s = attachGitSignals({ world, zones, fetchFn, intervalMs: 999999 })
    await s.poll()
    expect(setFreshness).toHaveBeenCalledWith(null)
    s.stop()
  })

  it('sets zone ownership from shortlog for the configured dirs', async () => {
    const zones = { setOwner: vi.fn() }
    const world = { agents: [] }
    const fetchFn: FetchStub = vi.fn(async (input) => {
      const url = String(input)
      if (url.includes('dir=web%2Fsrc')) return stubResponse({ ok: true, owners: [{ author: 'sara', commits: 10, share: 1 }] })
      return stubResponse({ ok: false })
    })
    const s = attachGitSignals({ world, zones, fetchFn, intervalMs: 999999, zoneDirs: { desks: 'web/src' } })
    await s.poll()
    expect(zones.setOwner).toHaveBeenCalledWith('desks', 'sara')
    s.stop()
  })

  it('never throws when fetchFn rejects or the endpoint is not up yet', async () => {
    const setFreshness = vi.fn()
    const world = { agents: [{ gitPath: 'web/src/office/anim.js', setFreshness }] }
    const zones = { setOwner: vi.fn() }
    const fetchFn: FetchStub = vi.fn(async () => { throw new Error('ECONNREFUSED') })
    const s = attachGitSignals({ world, zones, fetchFn, intervalMs: 999999 })
    await expect(s.poll()).resolves.toBeUndefined()
    expect(setFreshness).toHaveBeenCalledWith(null)
    s.stop()
  })

  it('swallows a malformed ok:true stat body as no signal', async () => {
    const setFreshness = vi.fn()
    const world = { agents: [{ gitPath: 'x', setFreshness }] }
    const zones = { setOwner: vi.fn() }
    const fetchFn: FetchStub = vi.fn(async () => stubResponse({ ok: true }))
    const s = attachGitSignals({ world, zones, fetchFn, intervalMs: 999999 })
    await s.poll()
    expect(setFreshness).toHaveBeenCalledWith(null)
    s.stop()
  })

  // -- forget: the per-agent counterpart to stop(), see office.html's
  // despawnLive. A stray reference in fxByAgent isn't just a memory nit —
  // deskHeat/deskDust's dispose() frees the GPU-side geometry, which a
  // WeakMap eventually reclaiming the JS wrapper would never do.
  it('forget disposes the desk-fx groups and drops the agent from the map', async () => {
    const root = { add: vi.fn(), remove: vi.fn() }
    const agent = { gitPath: 'web/src/office/anim.js', setFreshness: vi.fn(), setChurn: vi.fn(), root, scale: 1 }
    const world = { agents: [agent] }
    const zones = { setOwner: vi.fn() }
    const fetchFn: FetchStub = vi.fn(async () => stubResponse(null, false))
    const s = attachGitSignals({ world, zones, fetchFn, intervalMs: 999999 })
    await s.poll() // lazily builds the heat/cold desk-fx for agent.root
    expect(root.add).toHaveBeenCalled()

    s.forget(agent)
    // deskHeat/deskDust's dispose() detaches its group from the parent
    // it was added to — one call per treatment.
    expect(root.remove).toHaveBeenCalledTimes(2)

    // idempotent: nothing left to dispose the second time, so nothing throws
    expect(() => s.forget(agent)).not.toThrow()
    expect(root.remove).toHaveBeenCalledTimes(2)
    s.stop()
  })
})
