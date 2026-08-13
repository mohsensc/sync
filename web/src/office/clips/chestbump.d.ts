// Hand-written types for chestbump.js, same reason yield.d.ts/doubletake.d.ts
// exist: office/*.js runs unbundled and untyped in the browser and isn't
// part of tsconfig's allowJs surface, so a .ts test needs a declaration to
// import against without pulling all of office/ into the typecheck.

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

export const CHESTBUMP_CROUCH_T: number
export const CHESTBUMP_LAUNCH_T: number
export const CHESTBUMP_CONTACT_T: number
export const CHESTBUMP_RECOIL_T: number
export const CHESTBUMP_LAND_T: number
export const CHESTBUMP_SPEC: ClipSpec
export const CONTACT_Z_CM: number
export const CHESTBUMP_SPACING_RATIO: number
export const CHESTBUMP_SPACING: number

export const registry: { chestbump: ClipSpec }

export function spacingFor(height?: number): number
export function chestbumpMarks(
  aPos: THREE.Vector3 | [number, number?, number?],
  bPos: THREE.Vector3 | [number, number?, number?],
  spacing?: number
): Marks
export function getClip(): THREE.AnimationClip
export function chestPoint(root: THREE.Object3D, height?: number): THREE.Vector3 | null
export function measureContact(): THREE.Vector3 | null

export function yawTowards(dir: THREE.Vector3): number
export function palmPoint(root: THREE.Object3D, side?: 'Left' | 'Right', height?: number): THREE.Vector3 | null
export function handPoint(root: THREE.Object3D, side?: 'Left' | 'Right'): THREE.Vector3 | null
