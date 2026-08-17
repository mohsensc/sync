// Hand-written types for caption.js, same reason live.d.ts/reel.d.ts exist:
// office/*.js runs unbundled and untyped in the browser and isn't part of
// tsconfig's allowJs surface, so test/office-caption.test.ts needs a
// declaration to import against without pulling all of office/ into the
// typecheck.

export const PRIORITY: { demo: 0; replay: 1 }

export interface CaptionSetOptions {
  priority?: number
}

export interface CaptionArbiter {
  set(text: string, opts?: CaptionSetOptions): boolean
  hold(priority: number): object
  release(token: object | null): void
  isHeld(): boolean
}

export function createCaptionArbiter(write: (text: string) => void): CaptionArbiter
