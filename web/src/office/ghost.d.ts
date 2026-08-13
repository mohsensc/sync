// Hand-written types for ghost.js. See history-viz.d.ts / zoneowner.d.ts for
// why office/*.js needs one of these before a typechecked test can import
// it — this path is unbundled plain JS, not part of tsconfig's allowJs
// surface. Covers the pure decision logic vitest exercises; the THREE-
// object builders and attachGhostAuthors() are left loosely typed since
// nothing typechecked needs their shape yet.

export const ENCOUNTER_ARGUE_DAYS: number

export interface BlameOwner { author: string; lines: number; share: number }
export interface BlameBody {
  ok: boolean
  owners?: BlameOwner[]
  total?: number
  newestLineAgeDays?: number | null
  oldestLineAgeDays?: number | null
  reason?: string
}

export interface RosterEntry { id: string; human: string | null; busy: boolean }

export type GhostDecision =
  | { kind: 'none' }
  | { kind: 'ghost' | 'plate'; author: string; ageDays: number | null }
  | { kind: 'encounter'; author: string; ageDays: number | null; partnerId: string; clip: 'argue' | 'handshake' }

export function decideGhostTreatment(
  blame: BlameBody | null | undefined,
  roster: RosterEntry[] | null | undefined,
  opts?: { mode?: 'ghost' | 'plate' | 'off'; selfId?: string | null; encounterAgeDays?: number },
): GhostDecision

export function plateText(author: string, ageDays: number | null | undefined): string

export interface GhostAuthorsHandle {
  setMode(mode: 'ghost' | 'plate' | 'off'): void
  readonly mode: 'ghost' | 'plate' | 'off'
  tick(): Promise<void>
  dispose(): void
}

export function attachGhostAuthors(cfg?: {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  world?: any
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  scene?: any
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  skinnedClone?: any
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  makeCharacterRoot?: any
  hairFor?: (human: string) => string
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  getGltf?: () => any
  fetchFn?: (...args: unknown[]) => Promise<{ json(): Promise<unknown> }>
  intervalMs?: number
  now?: () => number
}): GhostAuthorsHandle
