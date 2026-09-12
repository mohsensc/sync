import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import {
  hashAccountTokenSecret,
  mintAccountToken,
  setupInstructions,
} from '../../api/_lib/tokens.js'

describe('account token helpers', () => {
  it('matches the Go verifier hash for a known 32-byte secret', () => {
    const secret = Buffer.from('AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8', 'base64url')
    expect(Buffer.from(hashAccountTokenSecret(secret)).toString('hex')).toBe(
      '630dcd2966c4336691125448bbb25b4ff412a49c732db2c8abc1b8581bd710dd',
    )
  })

  it('mints the required opaque token shape and hashes only the secret', () => {
    const token = mintAccountToken()
    expect(token.prefix).toMatch(/^ags_[0-9a-f]{32}$/)
    expect(token.secret).toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect(token.raw).toBe(`${token.prefix}.${token.secret}`)
    expect(Buffer.from(token.secretHash).toString('hex')).toBe(
      createHash('sha256').update(Buffer.from(token.secret, 'base64url')).digest('hex'),
    )
    expect(Buffer.from(token.secretHash).toString('utf8')).not.toContain(token.secret)
  })

  it('emits an invite the existing CLI can decode without putting secrets in a URL', () => {
    const instructions = setupInstructions('ags_deadbeef.secret', 'wss://relay.example.test')
    expect(instructions).toContain('installed from a tagged release')
    expect(instructions).not.toContain('npm install')
    const line = instructions.split('\n').find((value) => value.startsWith('agent-sync join '))
    expect(line).toBeTruthy()
    const blob = line!.slice('agent-sync join '.length)
    expect(JSON.parse(Buffer.from(blob, 'base64url').toString('utf8'))).toEqual({
      v: 1, relay: 'wss://relay.example.test', token: 'ags_deadbeef.secret',
    })
    expect(instructions).not.toContain('?token=')
  })
})
