import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it, vi } from 'vitest'

// health.ts must import database() but never requireUser()/ensurePersonalAccount() —
// this endpoint is deliberately the one that stays open. Mocking ../../api/_lib/db.js
// (rather than @neondatabase/serverless itself) matches the actual dependency edge
// health.ts imports; there's no existing test in this repo that exercises an endpoint
// handler against a mocked database() to follow instead (api-tokens.test.ts only
// covers pure helpers in tokens.ts, which has no db dependency at all).
const { queries, mockSql } = vi.hoisted(() => {
  const queries: { text: string; values: unknown[] }[] = []
  const mockSql = (strings: TemplateStringsArray, ...values: unknown[]) => {
    queries.push({ text: strings.join('?'), values })
    return Promise.resolve([{ '?column?': 1 }])
  }
  return { queries, mockSql }
})

vi.mock('../../api/_lib/db.js', () => ({
  database: () => mockSql,
}))

const { default: health } = await import('../../api/health.js')

describe('GET /api/health', () => {
  it('returns a minimal 200 with no auth header, cookie, or Clerk session', async () => {
    const request = new Request('https://example.test/api/health')
    expect(request.headers.has('authorization')).toBe(false)
    const response = await health.fetch(request)
    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual({ ok: true })
  })

  it('runs exactly one query, the literal SELECT 1, with no interpolated values', async () => {
    queries.length = 0
    await health.fetch(new Request('https://example.test/api/health'))
    expect(queries).toHaveLength(1)
    // Exact match, not a substring/denylist check: this is what pins the
    // query shape so a later edit can't quietly turn it into a table scan
    // or splice in a tenant-scoped value without failing this test.
    expect(queries[0].text).toBe('SELECT 1')
    expect(queries[0].values).toEqual([])
  })

  it('rejects non-GET methods like every other endpoint', async () => {
    const response = await health.fetch(
      new Request('https://example.test/api/health', { method: 'POST' }),
    )
    expect(response.status).toBe(405)
  })

  it('imports only the db/http helpers — never the auth or account modules', () => {
    const source = readFileSync(fileURLToPath(new URL('../../api/health.ts', import.meta.url)), 'utf8')
    const importLines = source.split('\n').filter((line) => line.trim().startsWith('import '))
    // Asserted at the dependency-graph level, not by grepping for the name
    // "requireUser" in the file text — this endpoint's own doc comment
    // explains *why* it skips requireUser()/ensurePersonalAccount(), and a
    // substring check would trip over that explanation.
    expect(importLines).toEqual([
      "import { database } from './_lib/db.js'",
      "import { endpoint, json } from './_lib/http.js'",
    ])
    for (const table of [
      'workspaces',
      'workspace_memberships',
      'app_users',
      'repositories',
      'agent_sessions',
      'resolution_events',
    ]) {
      expect(source.toLowerCase()).not.toContain(table)
    }
  })

  it('resolves quickly against a mocked database (real latency is checked live, not here)', async () => {
    const started = performance.now()
    await health.fetch(new Request('https://example.test/api/health'))
    expect(performance.now() - started).toBeLessThan(100)
  })
})
