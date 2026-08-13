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

export interface BlameResult {
  total: number
  owners: BlameOwner[]
  newestLineAgeDays: number | null
  oldestLineAgeDays: number | null
}

export function parseBlamePorcelain(text: string, now?: number): BlameResult

export interface LogEntry {
  sha: string
  author: string
  when: string
  subject: string
}

export function parseLog(text: string): LogEntry[]

export interface ShortlogOwner {
  author: string
  commits: number
}

export function parseShortlog(text: string): ShortlogOwner[]

export interface StatResult {
  commits: number
  authorCount: number
  lastAuthor: string
  lastAgeDays: number | null
  firstAgeDays: number | null
  lastSummary: string
}

export function parseStatLog(text: string, now?: number): StatResult | null

export type GitApiHandler = (req: { url?: string }, res: unknown, next: () => void) => void | Promise<void>

export function gitApiMiddleware(repoRoot: string): GitApiHandler
