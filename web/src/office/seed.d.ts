// Hand-written types for seed.js, same reason live.d.ts and reel.d.ts
// exist: office/*.js runs unbundled and untyped in the browser and isn't
// part of tsconfig's allowJs surface, so test/office-seed.test.ts needs a
// declaration to import against without pulling all of office/ into the
// typecheck.

import type { ReelEvent } from './live.d.ts'

export function seedEvents(now?: number): ReelEvent[]
