import { ensurePersonalAccount } from './_lib/account.js'
import { requireUser } from './_lib/auth.js'
import { database } from './_lib/db.js'
import { endpoint, HttpError, json, readJson } from './_lib/http.js'
import { mintAccountToken, relayUrl, setupInstructions } from './_lib/tokens.js'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

function cleanLabel(value: unknown): string | null {
  if (value == null || value === '') return null
  if (typeof value !== 'string') throw new HttpError(400, 'Token label must be a string.')
  const label = value.trim()
  if (!label || label.length > 80) throw new HttpError(400, 'Token label must be between 1 and 80 characters.')
  return label
}

async function createToken(request: Request): Promise<Response> {
  const user = await requireUser(request)
  const account = await ensurePersonalAccount(user.clerkUserId)
  const body = await readJson(request)
  const label = cleanLabel(body.label)
  const minted = mintAccountToken()
  const relay = relayUrl()
  const sql = database()
  const results = await sql.transaction((tx) => [
    // Serialize rotations for this account. Without this lock, two dashboard
    // tabs can each revoke the old token and then leave two new tokens live.
    tx`SELECT pg_advisory_xact_lock(hashtextextended(${`${account.workspaceId}:${account.userId}`}, 0))`,
    tx`
      UPDATE account_tokens
      SET revoked_at = now()
      WHERE workspace_id = ${account.workspaceId}
        AND user_id = ${account.userId}
        AND revoked_at IS NULL
    `,
    tx`
    INSERT INTO account_tokens (
      id, workspace_id, user_id, token_prefix, secret_sha256, label
    ) VALUES (
      ${minted.id}, ${account.workspaceId}, ${account.userId}, ${minted.prefix},
      ${Buffer.from(minted.secretHash)}, ${label}
    )
    RETURNING id, token_prefix, created_at
    `,
  ])
  const rows = results[2] as Array<{ id: string; token_prefix: string; created_at: string }>
  const created = rows[0]
  if (!created) throw new Error('token insert returned no row')
  return json({
    id: created.id,
    prefix: created.token_prefix,
    token: minted.raw,
    instructions: setupInstructions(minted.raw, relay),
    createdAt: created.created_at,
  }, 201)
}

async function revokeToken(request: Request): Promise<Response> {
  const user = await requireUser(request)
  const account = await ensurePersonalAccount(user.clerkUserId)
  const body = await readJson(request)
  if (typeof body.id !== 'string' || !UUID.test(body.id)) throw new HttpError(400, 'A valid token id is required.')
  const sql = database()
  const rows = await sql`
    UPDATE account_tokens
    SET revoked_at = COALESCE(revoked_at, now())
    WHERE id = ${body.id}
      AND workspace_id = ${account.workspaceId}
      AND user_id = ${account.userId}
    RETURNING id
  ` as Array<{ id: string }>
  if (rows.length === 0) throw new HttpError(404, 'Token not found.')
  return new Response(null, { status: 204, headers: { 'Cache-Control': 'no-store' } })
}

export default {
  async fetch(request: Request): Promise<Response> {
    return endpoint(request, ['POST', 'DELETE'], () =>
      request.method === 'POST' ? createToken(request) : revokeToken(request),
    )
  },
}
