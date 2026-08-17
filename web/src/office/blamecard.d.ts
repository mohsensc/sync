// Hand-written types for blamecard.js — same reason as live.d.ts /
// histshelf.d.ts: office/*.js is unbundled plain JS, outside tsconfig's
// allowJs surface, so a typechecked test importing it needs a declaration
// file. Covers the pure region-blame exports test/region-blame.test.ts
// exercises directly; attachBlameCard()'s DOM controller is left loosely
// typed since nothing typechecked calls into it today.

export interface BlameOwner {
  author: string
  lines: number
  share: number
}

export interface BlameResult {
  ok: boolean
  reason?: string
  total?: number
  owners?: BlameOwner[]
  newestLineAgeDays?: number | null
  oldestLineAgeDays?: number | null
}

export interface LogEntry {
  sha?: string
  author?: string
  when?: string
  subject?: string
}

export interface AgentLike {
  id?: string
  name?: string
  role?: string
  gitPath?: string | null
  gitStart?: number
  gitEnd?: number
}

export function hasUsableRegion(agent: AgentLike | null | undefined): boolean
export function regionBlameUsable(regionBlame: BlameResult | null | undefined): boolean

export interface RegionSegment {
  author: string
  pct: number
  self: boolean
}

export function regionGutterSegments(
  blame: BlameResult | null | undefined,
  agent?: AgentLike | null
): RegionSegment[]

export interface RegionSummary {
  total: number
  topAuthor: string | null
  topPct: number | null
  multiAuthor: boolean
  ageLabel: string | null
}

export function regionSummary(blame: BlameResult | null | undefined): RegionSummary | null

export function isSingleOwner(blame: BlameResult | null | undefined): boolean

export function pickDefaultVariant(blame: BlameResult | null | undefined): 'story' | 'graphic'

export interface SingleOwnerSummary {
  author: string
  total: number
  ageLabel: string | null
}

export function singleOwnerSummary(blame: BlameResult | null | undefined): SingleOwnerSummary | null

export interface SourceResult {
  ok: boolean
  reason?: string
  lines?: string[]
}

export interface LineBlameEntry {
  n: number
  author: string
  ageDays: number | null
}

export interface LineBlameResult extends BlameResult {
  lines?: LineBlameEntry[]
}

export interface GutterRow {
  n: number
  text: string
  author: string | null
  opacity: number
}

export function buildGutterRows(
  sourceResp: SourceResult | null | undefined,
  lineBlameResp: LineBlameResult | null | undefined,
  opts?: { startLine?: number }
): GutterRow[] | null

export interface BlameCardHandle {
  show(agent: AgentLike | null | undefined): void
  hide(): void
  setVariant(name: string): void
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  el: any
}

export function attachBlameCard(cfg?: {
  fetchFn?: (...args: unknown[]) => Promise<{ json(): Promise<unknown> }>
  onClose?: () => void
}): BlameCardHandle
