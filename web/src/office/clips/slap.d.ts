// Hand-written types for slap.js, same reason yield.d.ts/doubletake.d.ts
// exist: office/*.js runs unbundled and untyped in the browser and isn't
// part of tsconfig's allowJs surface, so
// test/office-clips-dominance-variants.test.ts needs a declaration to
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

export const SLAP_CONTACT_T: number
export const CONTACT_Y_CM: number
export const CONTACT_Z_CM: number
export const SLAP_SPACING_RATIO: number
export const SLAP_SPACING: number

export type SlapRegistry = { slap: ClipSpec; slapReact: ClipSpec }
export const registry: SlapRegistry

export function spacingFor(height?: number): number
export function slapMarks(
  aPos: THREE.Vector3 | [number, number?, number?],
  bPos: THREE.Vector3 | [number, number?, number?],
  spacing?: number
): Marks
export function getClip(name: 'slap' | 'slapReact'): THREE.AnimationClip

export function measureContact(): THREE.Vector3
export function palmPoint(root: THREE.Object3D, side?: 'Left' | 'Right', height?: number): THREE.Vector3
export function handPoint(root: THREE.Object3D, side?: 'Left' | 'Right'): THREE.Vector3
export function boneAt(clipName: 'slap' | 'slapReact', t: number, boneName: string): THREE.Vector3
