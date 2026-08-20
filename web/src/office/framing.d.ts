// Hand-written types for framing.js. office/*.js runs unbundled and untyped
// in the browser (see live.d.ts's header for the full story) so it isn't
// part of tsconfig's `allowJs` surface. This file exists only so a
// typechecked test can import framing.js's pure functions (clampYaw,
// yawMiss, headFraming, pickFraming) without tsc erroring on a module with
// no declaration. Not a full surface for office.html's camera state —
// extend it if a future test needs more.

// Minimal shape framing.js actually reads off an agent — just the facing
// yaw. agent.js's Agent has far more on it; this file doesn't need the rest.
export interface FramingAgent {
  yaw: number
}

export interface HeadFraming {
  yaw: number
  pitch: number
  dist: number
  y: number
}

export type FrameMode = 'threequarter' | 'shoulder'

export const YAW_MIN: number
export const YAW_MAX: number
export const YAW_MID: number

export function clampYaw(y: number): number
export function yawMiss(y: number): number

export const HEAD_Y: number
export const HEAD_DIST: number
export const HEAD_YAW_OFFSET: number
export const HEAD_PITCH: number
export const SHOULDER_DIST: number
export const SHOULDER_Y: number
export const SHOULDER_YAW_OFFSET: number
export const SHOULDER_PITCH: number

export function headFraming(a: FramingAgent, mode: FrameMode | null | undefined): HeadFraming
export function pickFraming(a: FramingAgent): HeadFraming
export function resolveFrameMode(m: unknown): FrameMode | null
