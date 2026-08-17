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

export interface ReelPage {
  shown: ReelEvent[]
  remaining: number
}

export declare class ReelStore {
  constructor(events?: ReelEvent[])
  add(event: ReelEvent): ReelEvent
  readonly size: number
  setRungFilter(rung: Rung | 'all'): void
  readonly rungFilter: Rung | 'all'
  setHumanFilter(human: string): void
  readonly humanFilter: string
  setSortMode(mode: ReelSortMode): void
  readonly sortMode: ReelSortMode
  humans(): string[]
  all(): ReelEvent[]
  visible(): ReelEvent[]
  toggleOpen(id: string): void
  readonly openId: string | null
  closeOpen(): void
  setPlaying(id: string | null): void
  clearPlaying(): void
  readonly playingId: string | null
  readonly revealCount: number
  resetReveal(): void
  showMore(step?: number): void
  page(): ReelPage
  takeNewLiveIds(): string[]
}

export const SAMPLE_EVENTS: ReelEvent[]

export type ReelSortMode = 'new' | 'worst' | 'worst-grouped'

export const SORT_MODES: ReelSortMode[]

export function relTime(ts: number, now: number): string

export type ReelSkin = 'paper' | 'glass' | 'ticker'

export const SKINS: ReelSkin[]

export function resolveSkin(value: string | null | undefined): ReelSkin

export interface MountReelOptions {
  onSelect?: (event: ReelEvent) => void
  skin?: ReelSkin
}

export interface MountedReel {
  render(): void
  setFoot(html: string): void
  setPlaying(id: string | null): void
  clearPlaying(): void
  getSkin(): ReelSkin
  setSkin(skin: ReelSkin): void
  dispose(): void
}

export function mountReel(container: HTMLElement, store: ReelStore, opts?: MountReelOptions): MountedReel
