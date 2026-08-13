// Hand-written types for history-viz.js. See agent.d.ts / live.d.ts for why
// office/*.js needs one of these for a typechecked test to import it.

export function hashString(s: string): number
export function hueForAuthor(name: string): number
export function colorForAuthor(name: string, opts?: { light?: number; sat?: number }): string
export function parseRelativeAge(when: string | null | undefined): number | null
export function ageToX(days: number | null | undefined, maxDays: number | null | undefined): number
