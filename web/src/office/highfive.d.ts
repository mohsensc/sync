// Hand-written types for highfive.js, same reason yield.d.ts exists: office/
// *.js runs unbundled and untyped in the browser and isn't part of
// tsconfig's allowJs surface, so office-stage-clearance.test.ts needs a
// declaration to build real STAGE_MARKS-shaped fixtures without pulling all
// of office/ into the typecheck. Not a full surface for highfive.js —
// extend it if a future test needs more (highfiveRoutine etc. are still
// untyped from here).

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

export const CHARACTER_HEIGHT: number
export const HIGHFIVE_SPACING_RATIO: number
export const HIGHFIVE_SPACING: number
export const CONTACT_T: number

export function spacingFor(height?: number): number
export function yawTowards(dir: THREE.Vector3): number
export function highfiveMarks(
  aPos: THREE.Vector3 | [number, number?, number?],
  bPos: THREE.Vector3 | [number, number?, number?],
  spacing?: number
): Marks
