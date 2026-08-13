// Hand-written types for reel.js, same reason live.d.ts exists: office/*.js
// runs unbundled and untyped in the browser and isn't part of tsconfig's
// allowJs surface, so test/office-reel.test.ts needs a declaration to import
// against without pulling all of office/ into the typecheck.

export type Rung = 0 | 1 | 2 | 3 | 4

export interface ReelParty {
  agent: string
  human: string
}

export type ResolutionKind = 'wait' | 'abort' | 'share' | 'redundant' | 'read-yield'

export interface ReelResolution {
  kind: ResolutionKind
  detail?: string
}

export interface ReelEvent {
  id: string
  ts: number
  rung: Rung
  a: ReelParty
  b: ReelParty
  path: string
  resolution: ReelResolution | null
  source: 'live' | 'generated'
}

export declare class ReelStore {
  constructor(events?: ReelEvent[])
  add(event: ReelEvent): ReelEvent
  readonly size: number
  setRungFilter(rung: Rung | 'all'): void
  readonly rungFilter: Rung | 'all'
  setHumanFilter(human: string): void
  readonly humanFilter: string
  humans(): string[]
  all(): ReelEvent[]
  visible(): ReelEvent[]
}

export const SAMPLE_EVENTS: ReelEvent[]

export interface MountReelOptions {
  onSelect?: (event: ReelEvent) => void
}

export interface MountedReel {
  render(): void
  setFoot(html: string): void
}

export function mountReel(container: HTMLElement, store: ReelStore, opts?: MountReelOptions): MountedReel
