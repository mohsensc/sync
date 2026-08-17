import { describe, it, expect } from 'vitest'
import { resolveSkin, SKINS } from '../src/office/reel.js'

describe('resolveSkin', () => {
  it('accepts every listed skin', () => {
    for (const s of SKINS) expect(resolveSkin(s)).toBe(s)
  })

  it('falls back to paper for anything unrecognized', () => {
    expect(resolveSkin(undefined)).toBe('paper')
    expect(resolveSkin(null)).toBe('paper')
    expect(resolveSkin('')).toBe('paper')
    expect(resolveSkin('neon')).toBe('paper')
    expect(resolveSkin('Glass')).toBe('paper') // case-sensitive, no normalizing surprise
  })
})
