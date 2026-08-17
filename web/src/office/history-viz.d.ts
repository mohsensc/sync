// Hand-written types for history-viz.js. See agent.d.ts / live.d.ts for why
// office/*.js needs one of these for a typechecked test to import it.

export function hashString(s: string): number
export function hueForAuthor(name: string): number
export function colorForAuthor(name: string, opts?: { light?: number; sat?: number }): string
export function parseRelativeAge(when: string | null | undefined): number | null
export function ageToX(days: number | null | undefined, maxDays: number | null | undefined): number

export interface TimelineSlot {
  x: number
  bucketSize: number
  bucketPos: number
}

export function stackTimelinePositions(
  ages: (number | null | undefined)[],
  maxDays: number | null | undefined,
  slop?: number
): TimelineSlot[]

export function formatAge(days: number | null | undefined): string | null

export interface StoryResult {
  lines: string[]
  commits: unknown[]
}

export function composeStory(
  stat: { ok?: boolean; commits?: number; lastAuthor?: string; lastAgeDays?: number | null; firstAgeDays?: number | null } | null | undefined,
  log: { ok?: boolean; entries?: Array<{ sha?: string; author?: string; when?: string; subject?: string }> } | null | undefined,
  blame: { ok?: boolean; owners?: Array<{ author?: string; share?: number }> } | null | undefined
): StoryResult
