import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { HttpError } from './http.js'

export interface MintedToken {
  id: string
  prefix: string
  secret: string
  raw: string
  secretHash: Uint8Array
}

export function hashAccountTokenSecret(secretBytes: Uint8Array): Uint8Array {
  return createHash('sha256').update(secretBytes).digest()
}

export function mintAccountToken(): MintedToken {
  const id = randomUUID()
  const prefix = `ags_${id.replaceAll('-', '')}`
  const secretBytes = randomBytes(32)
  const secret = secretBytes.toString('base64url')
  return {
    id,
    prefix,
    secret,
    raw: `${prefix}.${secret}`,
    secretHash: hashAccountTokenSecret(secretBytes),
  }
}

export function relayUrl(): string {
  const value = process.env.AGENT_SYNC_RELAY_URL || process.env.VITE_AGENT_SYNC_RELAY_URL
  if (!value) throw new HttpError(503, 'Hosted relay is not configured.')
  let parsed: URL
  try { parsed = new URL(value) } catch { throw new HttpError(503, 'Hosted relay URL is invalid.') }
  if (parsed.protocol !== 'wss:' && !(parsed.protocol === 'ws:' && ['127.0.0.1', 'localhost', '::1'].includes(parsed.hostname))) {
    throw new HttpError(503, 'Hosted relay URL must use wss://.')
  }
  return parsed.toString().replace(/\/$/, '')
}

export function setupInstructions(rawToken: string, relay: string): string {
  const blob = Buffer.from(JSON.stringify({ v: 1, relay, token: rawToken }), 'utf8').toString('base64url')
  return [
    'Agent Sync must already be installed from a tagged release. Then connect this machine to your account:',
    '',
    `agent-sync join ${blob}`,
    'agent-sync setup',
    '',
    'The setup token is shown once. Keep these instructions private.',
  ].join('\n')
}
