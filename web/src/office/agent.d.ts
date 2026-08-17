// Hand-written types for agent.js. office/*.js runs unbundled and untyped in
// the browser (see live.d.ts's header for the full story) so it isn't part
// of tsconfig's `allowJs` surface. This file exists only so a typechecked
// test can import the one pure function it needs (freshnessBucket) without
// tsc erroring on a module with no declaration. Not a full surface for
// Agent/World — extend it if a future test needs more of agent.js.

export type FreshnessBucket = 'fresh' | 'warm' | 'normal' | 'stale' | null

export function freshnessBucket(ageDays: number | null | undefined): FreshnessBucket
