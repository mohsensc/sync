// Hand-written types for agent.js. office/*.js runs unbundled and untyped in
// the browser (see live.d.ts's header for the full story) so it isn't part
// of tsconfig's `allowJs` surface. This file exists only so a typechecked
// test can import the pure functions it needs (freshnessBucket, clearMarks)
// without tsc erroring on a module with no declaration. Not a full surface
// for Agent/World — extend it if a future test needs more of agent.js.

import type * as THREE from 'three'

export type FreshnessBucket = 'fresh' | 'warm' | 'normal' | 'stale' | null

export function freshnessBucket(ageDays: number | null | undefined): FreshnessBucket

/** A single mark: where a character stands and which way it faces, per the
 *  highfiveMarks-style convention every STAGE_MARKS entry returns. */
export interface StageMark {
  pos: THREE.Vector3
  yaw: number
}

/** What STAGE_MARKS[kind](a, b, height) returns, and what clearMarks() takes
 *  and hands back — a and b's separation and facing, tied to `spacing`. */
export interface StageMarks {
  a: StageMark
  b: StageMark
  spacing: number
}

/** A circle to stay clear of: desk cluster, or one other live agent. */
export interface ClearanceObstacle {
  x: number
  z: number
  r: number
}

export interface ClearMarksOpts {
  margin?: number
  maxTries?: number
}

export function clearMarks(
  marks: StageMarks,
  obstacles: ClearanceObstacle[],
  opts?: ClearMarksOpts
): StageMarks
