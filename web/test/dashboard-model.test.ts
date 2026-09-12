import { describe, expect, it } from 'vitest'
import { ACTIVE_WINDOW_MS, activeAgents, isActive, relativeTime, selectRepository } from '../src/dashboard-model.js'
import type { RepositorySummary } from '../src/dashboard-model.js'

const now = Date.parse('2026-09-12T12:00:00.000Z')
const repo = (id: string, seen: string): RepositorySummary => ({
  id, name: id, roomKey: `room-${id}`, lastSeenAt: seen,
  agents: [{ id: `session-${id}`, agentId: `agent-${id}`, human: 'sara', verb: 'edit', path: 'a.ts', intent: 'ship it', lastSeenAt: seen }],
  resolutions: [],
})

describe('dashboard model', () => {
  it('uses the relay presence TTL as the active boundary', () => {
    expect(isActive(new Date(now - ACTIVE_WINDOW_MS).toISOString(), now)).toBe(true)
    expect(isActive(new Date(now - ACTIVE_WINDOW_MS - 1).toISOString(), now)).toBe(false)
  })

  it('does not present malformed or far-future timestamps as active', () => {
    expect(isActive('not-a-date', now)).toBe(false)
    expect(isActive(new Date(now + 6_000).toISOString(), now)).toBe(false)
  })

  it('filters stale sessions without removing them from the payload', () => {
    const fresh = repo('fresh', new Date(now - 5_000).toISOString())
    const stale = repo('stale', new Date(now - 31_000).toISOString())
    fresh.agents.push(...stale.agents)
    expect(activeAgents(fresh, now).map((agent) => agent.id)).toEqual(['session-fresh'])
  })

  it('keeps a selected repository or falls back deterministically', () => {
    const repos = [repo('one', new Date(now).toISOString()), repo('two', new Date(now).toISOString())]
    expect(selectRepository(repos, 'two')?.id).toBe('two')
    expect(selectRepository(repos, 'gone')?.id).toBe('one')
    expect(selectRepository([], null)).toBeNull()
  })

  it('formats dashboard timestamps compactly', () => {
    expect(relativeTime(new Date(now - 4_000).toISOString(), now)).toBe('just now')
    expect(relativeTime(new Date(now - 45_000).toISOString(), now)).toBe('45s ago')
    expect(relativeTime(new Date(now - 120_000).toISOString(), now)).toBe('2m ago')
  })
})
