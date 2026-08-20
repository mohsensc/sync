// Hand-written types for demo.js. office/*.js runs unbundled and untyped in
// the browser (see live.d.ts's header for the full story) so it isn't part
// of tsconfig's `allowJs` surface. This file exists only so a typechecked
// test can import runDemo() without tsc erroring on a module with no
// declaration. ctx is loose on purpose — the test's own stub shapes the real
// contract; this just needs to not fight it.

export function runDemo(ctx: Record<string, unknown>): {
  update(dt: number): void
  promise: Promise<'done' | 'cancelled'>
  cancel(): void
}
