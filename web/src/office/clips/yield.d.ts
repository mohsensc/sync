// Hand-written types for yield.js, same reason live.d.ts/reel.d.ts exist:
// office/*.js runs unbundled and untyped in the browser and isn't part of
// tsconfig's allowJs surface, so test/office-clips-geometry.test.ts needs a
// declaration to import against without pulling all of office/ into the
// typecheck.

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

export interface YieldTiming {
  dur: number
  lookPeak: number
  lookWidth: number
  armPeak: number
  armWidth: number
  stepAmp: number
  hipsLiftAmp: number
  nodPeak: number
  nodWidth: number
}

export const YIELD_DUR: number
export const YIELD_SPACING: number
export const DEFAULT_TIMING: YieldTiming
export const EMPHATIC_TIMING: YieldTiming

export type YieldRegistry = { yieldStep: ClipSpec; yieldKeep: ClipSpec }

/** The picked take — the only one World ever sees. */
export const registry: YieldRegistry

/** Alternate takes for side-by-side comparison in yield-test.html only. */
export const variants: { default: YieldRegistry; emphatic: YieldRegistry }

export function spacingFor(height?: number): number
export function yieldMarks(
  aPos: THREE.Vector3 | [number, number?, number?],
  bPos: THREE.Vector3 | [number, number?, number?],
  spacing?: number
): Marks
export function getClip(name: 'yieldStep' | 'yieldKeep', reg?: YieldRegistry): THREE.AnimationClip

export interface RigPuppet {
  group: THREE.Object3D
  root: THREE.Object3D
  height: number
}

export function yieldRoutine(
  a: RigPuppet,
  b: RigPuppet,
  opts?: { speed?: number; turnRate?: number; settle?: number; arriveEps?: number; height?: number }
): { step: (dt: number) => string; marks: Marks; spacing: number; readonly phase: string }
