// Hand-written types for fistbump.js — see chestbump.d.ts's own header for
// why this exists (office/*.js is unbundled/untyped, outside allowJs).

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

export const FISTBUMP_CONTACT_T: number
export const FISTBUMP_HOLD_END_T: number
export const FISTBUMP_SPEC: ClipSpec
export const CONTACT_Y_CM: number
export const CONTACT_Z_CM: number
export const FISTBUMP_SPACING_RATIO: number
export const FISTBUMP_SPACING: number

export const registry: { fistbump: ClipSpec }

export function spacingFor(height?: number): number
export function fistbumpMarks(
  aPos: THREE.Vector3 | [number, number?, number?],
  bPos: THREE.Vector3 | [number, number?, number?],
  spacing?: number
): Marks
export function measureContact(): THREE.Vector3 | null

export function yawTowards(dir: THREE.Vector3): number
export function palmPoint(root: THREE.Object3D, side?: 'Left' | 'Right', height?: number): THREE.Vector3 | null
export function handPoint(root: THREE.Object3D, side?: 'Left' | 'Right'): THREE.Vector3 | null
