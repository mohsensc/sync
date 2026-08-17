// Hand-written types for gitapi.mjs, same reasoning as office/live.d.ts:
// this module is plain JS/ESM (a vite dev-server middleware, not part of
// the office/*.js browser surface either) and isn't in tsconfig's `allowJs`
// surface. This file exists only so test/gitapi.test.ts, which *is*
// typechecked, can import gitapi.mjs without `tsc --noEmit` erroring on a
// module with no declaration.

export function ageDays(epochSeconds: number | null | undefined, now?: number): number | null

export interface BlameOwner {
  author: string
  lines: number
  share: number
}

export interface BlameLine {
  n: number
  author: string
  ageDays: number | null
}

export interface BlameResult {
  total: number
  owners: BlameOwner[]
  newestLineAgeDays: number | null
  oldestLineAgeDays: number | null
  lines?: BlameLine[]
}

export interface ParseBlamePorcelainOpts {
  includeLines?: boolean
}

export function parseBlamePorcelain(text: string, now?: number, opts?: ParseBlamePorcelainOpts): BlameResult

export interface LogEntry {
  sha: string
  author: string
  when: string
  subject: string
}

export function parseLog(text: string): LogEntry[]

export interface RecentLogEntry {
  sha: string
  author: string
  subject: string
  ageDays: number | null
  files: number
}

export function parseRecentLog(
  text: string,
  now?: number,
  canonicalNames?: Map<string, string>
): RecentLogEntry[]

export interface ShortlogRow {
  author: string
  email: string
  commits: number
}

export function parseShortlog(text: string): ShortlogRow[]

export function parseCanonicalNames(text: string): Map<string, string>

export interface ShortlogOwner {
  author: string
  commits: number
}

export function mergeAuthorsByEmail(
  rows: ShortlogRow[],
  canonicalNames?: Map<string, string>
): ShortlogOwner[]

export interface StatResult {
  commits: number
  authorCount: number
  lastAuthor: string
  lastAgeDays: number | null
  firstAgeDays: number | null
  lastSummary: string
}

export function parseStatLog(text: string, now?: number): StatResult | null

export interface ChurnLogResult {
  commits: number
  added: number
  deleted: number
}

export function parseChurnLog(text: string): ChurnLogResult

export interface NumstatResult {
  added: number
  deleted: number
}

export function parseNumstat(text: string): NumstatResult

export function clampLine(raw: string | number | null | undefined): number | null

export function blameRangeArgs(startRaw: string | null | undefined, endRaw: string | null | undefined): string[]

export type SourceSliceResult =
  | { ok: true; lines: string[] }
  | { ok: false; reason: string }

export function sliceSourceLines(
  text: string,
  startRaw: string | null | undefined,
  endRaw: string | null | undefined
): SourceSliceResult

export type GitApiHandler = (req: { url?: string }, res: unknown, next: () => void) => void | Promise<void>

export function gitApiMiddleware(repoRoot: string): GitApiHandler
