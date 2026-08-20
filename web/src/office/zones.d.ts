// Hand-written types for zones.js. office/*.js runs unbundled and untyped in
// the browser (see live.d.ts's header for the full story) so it isn't part
// of tsconfig's `allowJs` surface. This file exists only so a typechecked
// test can import the things it needs without tsc erroring on a module with
// no declaration. Not a full surface for zones.js — extend it if a future
// test needs more (zoneFor, yawToward, etc. are still untyped from here).

// [x, z, yaw] — yaw is zones.js's own EXTERNAL convention, see its header.
export type Slot = [number, number, number]

export interface Zone {
  label: string
  means: string
  prop: string | null
  at: [number, number]
  r: number
  color: number
  slots: Slot[]
}

export const ZONES: Record<string, Zone>
export const ZONE_NAMES: string[]

export interface ClaimedSlot {
  pos: [number, number]
  yaw: number
  index: number
  shared: boolean
}

export function claimSlot(
  zoneName: string,
  agentId: string,
  opts?: { share?: string | null },
): ClaimedSlot
export function releaseSlots(agentId: string): void
export function resetSlots(): void
