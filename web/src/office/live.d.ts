// Hand-written types for live.js. office/*.js runs unbundled and untyped in
// the browser (see office.html's importmap and README), so it is not part of
// tsconfig's `allowJs` surface — turning that on would pull every file under
// office/ into the typecheck, which is a much bigger change than this one
// module warrants. This file exists only so test/office-live.test.ts, which
// *is* typechecked, can import live.js without `tsc --noEmit` erroring on a
// module with no declaration.

export const RELAY_URL: string
export const PRESENCE_TTL_MS: number

export interface ConnectOptions {
  room: string
  human: string
  url?: string
  onPresence?: (msg: unknown) => void
  onDecision?: (msg: unknown) => void
  onRedundant?: (msg: unknown) => void
  onOpen?: () => void
  onClose?: () => void
}

export function connect(opts: ConnectOptions): { close(): void }
export function hairFor(human: string): number

export const LIVE_ABORT_VARIANTS: string[]
export function pickLiveVariant(
  kind: 'wait' | 'abort',
  winnerId: string,
  loserId: string,
): string | null

// Mirrors reel.d.ts's ReelEvent shape. Duplicated by hand rather than
// imported for the same reason live.js keeps its own copy of the hair
// palette: office/*.js modules don't import each other's types across this
// boundary, on purpose, so each stays independently buildable.
export type ReelRung = 0 | 1 | 2 | 3 | 4
export type ReelResolutionKind = 'wait' | 'abort' | 'share' | 'redundant' | 'read-yield'
export interface ReelParty { agent: string; human: string }
export interface ReelResolution { kind: ReelResolutionKind; detail?: string }
export interface ReelEvent {
  id: string
  ts: number
  rung: ReelRung
  a: ReelParty
  b: ReelParty
  path: string
  resolution: ReelResolution | null
  source: 'live' | 'generated'
}

export function toReelEvent(
  frame: unknown,
  now?: number,
  requester?: { agent: string; human: string } | null,
): ReelEvent | null

export interface PresenceInfo {
  id: string
  human: string
  verb: string
  path: string
  zone: string
  rung: number
  spawned: boolean
  contestWith: string | null
  shareWith: string | null
}

export interface LiveDirectorOptions {
  ttlMs?: number
  zoneFor?: (verb: string, path: string) => string
}

export interface ContestResolution {
  winnerId: string
  loserId: string
  kind: 'wait' | 'abort'
}

export interface ContestPair {
  path: string
  aId: string
  bId: string
}

export class LiveDirector {
  constructor(opts?: LiveDirectorOptions)
  // Exposed mainly for tests to assert on directly (see
  // office-live-decisions.test.ts) — callers driving the scene should go
  // through resolutionFor()/humanOf() rather than reading this map.
  contestPairs: Map<string, ContestPair>
  onPresence(msg: Record<string, unknown>, now?: number): PresenceInfo
  expire(now?: number): string[]
  has(id: string): boolean
  humanOf(id: string): string
  markContest(a: string, b: string): void
  clearContest(id: string): string | null
  contestPartner(id: string): string | null
  resolutionFor(frame: unknown): ContestResolution | null
}
