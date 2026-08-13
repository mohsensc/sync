// Hand-written types for doubletake.js — see yield.d.ts's header for why
// this exists (office/*.js is unbundled/untyped, outside tsconfig's allowJs
// surface).

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

export const DOUBLETAKE_DUR: number
export const DOUBLETAKE_SPACING: number

export const registry: { doubletake: ClipSpec }

export function spacingFor(height?: number): number
export function doubletakeMarks(
  aPos: THREE.Vector3 | [number, number?, number?],
  bPos: THREE.Vector3 | [number, number?, number?],
  spacing?: number
): Marks
export function getClip(): THREE.AnimationClip
export function playDoubletake(root: THREE.Object3D, fade?: number): THREE.AnimationAction

export interface RigPuppet {
  group: THREE.Object3D
  root: THREE.Object3D
  height: number
}

export function doubletakeRoutine(
  a: RigPuppet,
  b: RigPuppet,
  opts?: { speed?: number; turnRate?: number; settle?: number; arriveEps?: number; height?: number }
): { step: (dt: number) => string; marks: Marks; spacing: number; readonly phase: string }
