// Hand-written types for zoneowner.js. See history-viz.d.ts / agent.d.ts for
// why office/*.js needs one of these before a typechecked test can import
// it — this path is unbundled plain JS, not part of tsconfig's allowJs
// surface. Covers the pure ownership/colour math vitest exercises; the
// THREE-object builders and attachZoneOwner() are left loosely typed
// (`unknown`/`any`) since nothing typechecked needs their shape yet.

export const HAIR_COLORS: readonly string[]
export function hairFor(human: string): string

export const POSSESSIVE_SHARE: number
export const CONTESTED_MARGIN: number

export interface ShortlogOwner { author: string; commits: number; share: number }
export interface ShortlogBody {
  ok: boolean
  owners?: ShortlogOwner[]
  reason?: string
}

export interface Ownership {
  top: { author: string; commits: number; share: number }
  second: { author: string; commits: number; share: number } | null
  authorCount: number
  possessive: boolean
  contested: boolean
}

export function pickOwnership(data: ShortlogBody | null | undefined): Ownership | null
export function plaqueScale(share: number | null | undefined): number
export function rugSplit(ownership: Ownership | null | undefined): { topFrac: number; secondFrac: number }
export function flourishFor(ownership: Ownership | null | undefined): 'trophy' | 'contested' | null

export interface ZoneOwnerHandle {
  setZoneOwnership(zoneName: string, rawShortlogData: ShortlogBody | null | undefined): void
  setMode(mode: 'plaque' | 'rug'): void
  readonly mode: 'plaque' | 'rug'
  tick(): Promise<void>
  dispose(): void
}

export function attachZoneOwner(cfg?: {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  scene?: any
  zoneDirs?: Record<string, string>
  fetchFn?: (...args: unknown[]) => Promise<{ json(): Promise<unknown> }>
  intervalMs?: number
}): ZoneOwnerHandle
