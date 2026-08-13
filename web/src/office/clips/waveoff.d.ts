// Hand-written types for waveoff.js, same reason yield.d.ts/doubletake.d.ts
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

export const WAVEOFF_PEAK_T: number
export const WAVEOFF_SPACING: number

export type WaveoffRegistry = { waveoff: ClipSpec; waveoffReact: ClipSpec }
export const registry: WaveoffRegistry

export function spacingFor(height?: number): number
export function waveoffMarks(
  aPos: THREE.Vector3 | [number, number?, number?],
  bPos: THREE.Vector3 | [number, number?, number?],
  spacing?: number
): Marks
export function getClip(name: 'waveoff' | 'waveoffReact'): THREE.AnimationClip

export function palmPoint(root: THREE.Object3D, side?: 'Left' | 'Right', height?: number): THREE.Vector3
export function handPoint(root: THREE.Object3D, side?: 'Left' | 'Right'): THREE.Vector3
export function boneAt(clipName: 'waveoff' | 'waveoffReact', t: number, boneName: string): THREE.Vector3
