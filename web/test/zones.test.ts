import { describe, it, expect } from 'vitest'
import { PALETTE, hairFor, HAIR_COLORS } from '../src/palette.js'
import { ZONES, zoneFor } from '../src/zones.js'

describe('palette', () => {
  it('pins all fifteen colours as six-digit hex', () => {
    const values = Object.values(PALETTE)
    expect(values).toHaveLength(15)
    for (const v of values) expect(v).toMatch(/^#[0-9A-F]{6}$/)
  })

  it('assigns a stable hair colour per human', () => {
    expect(hairFor('sara')).toBe(hairFor('sara'))
    expect(HAIR_COLORS).toContain(hairFor('sara'))
  })

  it('spreads different humans across different colours', () => {
    const assigned = new Set(['sara', 'dev', 'ali', 'kim'].map(hairFor))
    expect(assigned.size).toBeGreaterThan(1)
  })
})

describe('zones', () => {
  it('sends auth and secrets work to the vault', () => {
    expect(zoneFor('edit', 'src/auth/session.ts')).toBe('vault')
    expect(zoneFor('edit', 'config/secrets.py')).toBe('vault')
  })

  it('sends CI config to the conveyor', () => {
    expect(zoneFor('edit', '.github/workflows/ci.yml')).toBe('conveyor')
  })

  it('sends dependency manifests to the cable ball', () => {
    expect(zoneFor('edit', 'package.json')).toBe('cables')
    expect(zoneFor('edit', 'requirements.txt')).toBe('cables')
  })

  it('sends test failures to the fire desk', () => {
    expect(zoneFor('run', 'tests/test_auth.py')).toBe('fire')
  })

  it('sends reasoning to the ducks', () => {
    expect(zoneFor('think', 'anything.ts')).toBe('ducks')
  })

  it('falls back to desks for ordinary work', () => {
    expect(zoneFor('edit', 'src/util/format.ts')).toBe('desks')
  })

  it('gives every zone a non-zero footprint so characters can stand in it', () => {
    for (const z of Object.values(ZONES)) {
      expect(z.w).toBeGreaterThan(0)
      expect(z.d).toBeGreaterThan(0)
    }
  })

  it('never overlaps two zones, so position is unambiguous', () => {
    const boxes = Object.values(ZONES)
    for (let i = 0; i < boxes.length; i++) {
      for (let j = i + 1; j < boxes.length; j++) {
        const a = boxes[i], b = boxes[j]
        const overlap =
          Math.abs(a.x - b.x) < (a.w + b.w) / 2 &&
          Math.abs(a.z - b.z) < (a.d + b.d) / 2
        expect(overlap).toBe(false)
      }
    }
  })
})
