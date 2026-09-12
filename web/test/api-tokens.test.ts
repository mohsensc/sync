import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import {
  hashAccountTokenSecret,
  isSetupTarget,
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
    expect(instructions).toContain('signed-in user at https://www.agentsync.studio/')
    expect(instructions).toContain('ask the user to confirm that they personally copied this block')
    expect(instructions).toContain('Wait for explicit approval')
    expect(instructions).toContain('https://github.com/mohsensc/sync')
    expect(instructions).toContain('not yet publicly distributed')
    expect(instructions).toContain('Do not search for, download, or substitute another package or binary')
    expect(instructions).toContain('command -v agent-sync && agent-sync --version')
    expect(instructions).not.toContain('npm install')
    expect(instructions).not.toContain('curl')
    expect(instructions).not.toContain('wget')
    const line = instructions.split('\n').find((value) => value.startsWith('agent-sync join '))
    expect(line).toBeTruthy()
    const blob = line!.slice('agent-sync join '.length)
    expect(JSON.parse(Buffer.from(blob, 'base64url').toString('utf8'))).toEqual({
      v: 1, relay: 'wss://relay.example.test', token: 'ags_deadbeef.secret',
    })
    expect(instructions).not.toContain('?token=')
    expect(instructions).toContain('Expected relay: wss://relay.example.test')
    expect(instructions).toContain('Do not decode, reprint, log, commit, upload, or send it anywhere else')
    expect(instructions).toContain('Never conceal actions or output from the user')
  })

  it('warns about the unrelated @agent-sync/cli npm collision', () => {
    const instructions = setupInstructions('ags_deadbeef.secret', 'wss://relay.example.test')
    expect(instructions).toContain('@agent-sync/cli')
    expect(instructions).toContain('pre-existing, unrelated project')
    expect(instructions).toContain('scripts/build-npm-packages.sh --pack')
  })

  it('validates target ids', () => {
    expect(isSetupTarget('claude-code')).toBe(true)
    expect(isSetupTarget('codex')).toBe(true)
    expect(isSetupTarget('grok')).toBe(true)
    expect(isSetupTarget('gemini-cli')).toBe(true)
    expect(isSetupTarget('muse')).toBe(true)
    expect(isSetupTarget('chatgpt')).toBe(false)
    expect(isSetupTarget('')).toBe(false)
    expect(isSetupTarget(undefined)).toBe(false)
  })

  it('gives Claude Code both the hook/MCP wiring and a CLAUDE.md+AGENTS.md write', () => {
    const instructions = setupInstructions('ags_deadbeef.secret', 'wss://relay.example.test', ['claude-code'])
    expect(instructions).toContain('agent-sync setup')
    expect(instructions).toContain('## Agent Sync')
    expect(instructions).toContain('append the identical "## Agent Sync" section to CLAUDE.md')
    expect(instructions).toContain('PreToolUse/PostToolUse hook')
    expect(instructions).toContain('arbitrates tool calls automatically')
    // Single-target selection: no "for X, Y: agent-sync setup does not
    // register..." disclaimer should appear, since nothing was excluded.
    expect(instructions).not.toContain('does not register an MCP server')
  })

  it('gives a non-Claude target only an AGENTS.md write, no hook/MCP claim', () => {
    const instructions = setupInstructions('ags_deadbeef.secret', 'wss://relay.example.test', ['codex'])
    expect(instructions).toContain('For Codex: agent-sync setup does not register an MCP server or install any hook')
    expect(instructions).toContain('## Agent Sync')
    expect(instructions).not.toContain('CLAUDE.md')
    expect(instructions.split('\n')).not.toContain('agent-sync setup')
    expect(instructions).toContain('not part of this connection')
    expect(instructions).toContain('There is no tool-call enforcement')
  })

  it('does not assert MCP tools are registered for any non-Claude target', () => {
    for (const target of ['codex', 'grok', 'gemini-cli', 'muse'] as const) {
      const instructions = setupInstructions('ags_deadbeef.secret', 'wss://relay.example.test', [target])
      expect(instructions).toContain('does not register an MCP server or install any hook')
      expect(instructions, `${target} instructions should not claim automatic enforcement`).not.toContain('arbitrates tool calls automatically')
    }
  })

  it('adds the GEMINI.md precedence caveat only when gemini-cli is selected', () => {
    const withGemini = setupInstructions('ags_deadbeef.secret', 'wss://relay.example.test', ['gemini-cli'])
    expect(withGemini).toContain('GEMINI.md takes precedence')

    const withoutGemini = setupInstructions('ags_deadbeef.secret', 'wss://relay.example.test', ['codex'])
    expect(withoutGemini).not.toContain('GEMINI.md')
  })

  it('handles a mixed Claude Code + non-Claude selection honestly per target', () => {
    const instructions = setupInstructions('ags_deadbeef.secret', 'wss://relay.example.test', ['claude-code', 'grok'])
    expect(instructions).toContain('Selected agent(s): Claude Code, Grok')
    expect(instructions).toContain('append the identical "## Agent Sync" section to CLAUDE.md')
    expect(instructions).toContain('For Grok: agent-sync setup does not register an MCP server or install any hook')
    expect(instructions).toContain('agent-sync setup')
  })

  it('falls back to Claude Code when given no valid targets, and de-dupes', () => {
    const empty = setupInstructions('ags_deadbeef.secret', 'wss://relay.example.test', [])
    expect(empty).toContain('Selected agent(s): Claude Code')

    const deduped = setupInstructions('ags_deadbeef.secret', 'wss://relay.example.test', ['codex', 'codex'])
    expect(deduped).toContain('Selected agent(s): Codex')
    expect((deduped.match(/For Codex:/g) ?? []).length).toBe(1)
  })
})
