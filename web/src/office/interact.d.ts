// Hand-written types for interact.js. office/*.js runs unbundled and untyped
// in the browser (see live.d.ts's header for the full story) so it isn't
// part of tsconfig's `allowJs` surface. This file exists only so a
// typechecked test can import the one pure function it needs
// (ownershipShare) without tsc erroring on a module with no declaration.
// Not a full surface for attachInteraction — extend it if a future test
// needs more of interact.js.

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

export interface OwnershipShare {
  pct: number
  matched: boolean
  name: string
}

export function ownershipShare(
  blame: BlameResult | null | undefined,
  identity: string | null | undefined
): OwnershipShare | null
