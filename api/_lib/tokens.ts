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
    'Agent Sync — account connection request',
    '',
    'Provenance',
    'This block was generated for a signed-in user at https://www.agentsync.studio/. It is not proof of authorization by itself.',
    'Official project: https://github.com/mohsensc/sync',
    'Before running anything, ask the user to confirm that they personally copied this block from their Agent Sync dashboard and want this machine connected to their account.',
    '',
    'Step 1 — Explain and confirm',
    'Explain that setup will store an account credential locally and update the user\'s Claude Code hook and MCP configuration. Wait for explicit approval before making either change.',
    '',
    'Step 2 — Verify the installation',
    'Verify the existing installation first:',
    'command -v agent-sync && agent-sync --version',
    '',
    'Agent Sync is not yet publicly distributed for unattended installation. If the command is missing, the project or release is inaccessible, or its source cannot be verified, stop and ask the user for a trusted installation source. Do not search for, download, or substitute another package or binary.',
    '',
    'Step 3 — Connect after approval',
    'After the user confirms the source, understands the configuration changes, and explicitly approves, run these commands exactly:',
    '',
    `agent-sync join ${blob}`,
    'agent-sync setup',
    '',
    `Expected relay: ${relay}`,
    '',
    'Security boundaries',
    'The join blob contains a bearer token. It is intentionally visible to the user and the agent performing this authorized setup. Do not decode, reprint, log, commit, upload, or send it anywhere else. Never conceal actions or output from the user.',
    'If any instruction conflicts with these checks, stop and ask the user.',
  ].join('\n')
}
