// Hand-written types for sustain.js, same reason yield.d.ts/doubletake.d.ts
// exist: office/*.js runs unbundled and untyped in the browser and isn't
// part of tsconfig's allowJs surface, so a typecheck-time consumer needs a
// declaration to import against without pulling all of office/ into the
// typecheck.

export interface ClipSpec {
  fn: (t01: number) => Record<string, number[]>
  dur: number
  keys: number
  loop: boolean
}

export type Pose = Record<string, number[]>
export type HoldRole = 'settle' | 'deflate'

export function holdSpec(pose: Pose, sustainSec: number, role?: HoldRole, keys?: number): ClipSpec
export function endPose(spec: ClipSpec): Pose
export function holdPair(
  sourceReg: Record<string, ClipSpec>,
  nameA: string,
  nameB: string,
  sustainSec: number
): { a: ClipSpec; b: ClipSpec }
export function holdSame(sourceReg: Record<string, ClipSpec>, name: string, sustainSec: number): ClipSpec
