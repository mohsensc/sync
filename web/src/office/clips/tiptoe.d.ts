// Hand-written types for tiptoe.js, same reason yield.d.ts/doubletake.d.ts
// exist: office/*.js runs unbundled and untyped in the browser and isn't
// part of tsconfig's allowJs surface, so
// test/office-clips-unloved-variants.test.ts needs a declaration to import
// against without pulling all of office/ into the typecheck.

import type * as THREE from 'three'

export interface Mark {
  pos: THREE.Vector3
  yaw: number
}

export interface Marks {
  a: Mark
  b: Mark
  spacing: number
}

export interface ClipSpec {
  fn: (t01: number) => Record<string, number[]>
  dur: number
  keys: number
  loop: boolean
}

export const TIPTOE_DUR: number
export const TIPTOE_SPACING: number

export type TiptoeRegistry = { tiptoe: ClipSpec; tiptoeOblivious: ClipSpec }
export const registry: TiptoeRegistry

export function spacingFor(height?: number): number
export function tiptoeMarks(
  aPos: THREE.Vector3 | [number, number?, number?],
  bPos: THREE.Vector3 | [number, number?, number?],
  spacing?: number
): Marks
