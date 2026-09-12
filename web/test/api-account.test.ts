import { beforeEach, describe, expect, it, vi } from 'vitest'
const mocks = vi.hoisted(() => ({ auth: vi.fn(), sql: vi.fn(), deleteUser: vi.fn() }))
vi.mock('../../api/_lib/auth.js', () => ({ requireUser: mocks.auth }))
vi.mock('../../api/_lib/db.js', () => ({ database: () => mocks.sql }))
vi.mock('@clerk/backend', () => ({ createClerkClient: () => ({ users: { deleteUser: mocks.deleteUser } }) }))
import account from '../../api/account.js'
import { HttpError } from '../../api/_lib/http.js'

const request = (body: unknown = { confirmation: 'DELETE' }, origin = 'https://sync.test') => new Request('https://sync.test/api/account', {
  method: 'DELETE', headers: { 'Content-Type': 'application/json', Origin: origin }, body: JSON.stringify(body),
})
beforeEach(() => {
  vi.resetAllMocks()
  mocks.auth.mockResolvedValue({ clerkUserId: 'user_self' })
  mocks.sql.mockResolvedValue([])
  mocks.deleteUser.mockResolvedValue({})
})
describe('account deletion', () => {
  it('deletes only the authenticated identity after removing its app data', async () => {
    const response = await account.fetch(request({ confirmation: 'DELETE', userId: 'someone_else' }))
    expect(response.status).toBe(200)
    expect(mocks.sql.mock.calls[0][1]).toBe('user_self')
    expect(mocks.deleteUser).toHaveBeenCalledWith('user_self')
    expect(mocks.sql.mock.invocationCallOrder[0]).toBeLessThan(mocks.deleteUser.mock.invocationCallOrder[0])
  })
  it('rejects unauthenticated requests before any deletion', async () => {
    mocks.auth.mockRejectedValue(new HttpError(401, 'Unauthorized.'))
    expect((await account.fetch(request())).status).toBe(401)
    expect(mocks.sql).not.toHaveBeenCalled()
  })
  it('requires confirmation and rejects other origins', async () => {
    expect((await account.fetch(request({}))).status).toBe(400)
    expect((await account.fetch(request(undefined, 'https://elsewhere.test'))).status).toBe(403)
    expect(mocks.sql).not.toHaveBeenCalled()
  })
  it('keeps the identity if app data cleanup fails', async () => {
    mocks.sql.mockRejectedValue(new Error('database unavailable'))
    const log = vi.spyOn(console, 'error').mockImplementation(() => {})
    expect((await account.fetch(request())).status).toBe(503)
    expect(mocks.deleteUser).not.toHaveBeenCalled()
    log.mockRestore()
  })
  it('explains partial failure and permits an idempotent cleanup retry', async () => {
    mocks.deleteUser.mockRejectedValueOnce(new Error('Clerk unavailable'))
    const response = await account.fetch(request())
    expect(response.status).toBe(503)
    expect((await response.json()).error).toContain('workspace data and agent tokens were removed')
    expect((await account.fetch(request())).status).toBe(200)
  })
  it('rejects unsupported methods', async () => {
    expect((await account.fetch(new Request('https://sync.test/api/account'))).status).toBe(405)
    expect(mocks.auth).not.toHaveBeenCalled()
  })
})
