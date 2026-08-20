// Hand-written types for gitsignals.js. See agent.d.ts / live.d.ts for why
// office/*.js needs one of these for a typechecked test to import it.

export const ZONE_DIRS: Record<string, string>

export interface GitStatBody {
  ok: boolean
  commits?: number
  authorCount?: number
  lastAuthor?: string
  lastAgeDays?: number
  firstAgeDays?: number
  lastSummary?: string
  reason?: string
}

export interface GitOwner { author: string; commits: number; share: number }

export interface GitShortlogBody {
  ok: boolean
  owners?: GitOwner[]
  reason?: string
}

export interface GitChurnBody {
  ok: boolean
  recent?: { commits: number; added: number; deleted: number; windowDays: number }
  working?: { added: number; deleted: number }
  reason?: string
}

export function statToAgeDays(data: GitStatBody | null | undefined): number | null
export function shortlogToOwner(data: GitShortlogBody | null | undefined): string | null
export function churnToIntensity(data: GitChurnBody | null | undefined): number | null

/** The three churn-vis treatments cycled by the 'C' key / ?churnMode= —
 *  see attachGitSignals's own comment for what each one looks like. */
export const CHURN_MODES: readonly ['stack', 'heat', 'cold']
export type ChurnMode = (typeof CHURN_MODES)[number]

/** ageDays -> 0..1 "how abandoned does this feel", for the 'cold' churn
 *  treatment (dust/cobweb). 0 below the fresh floor, 1 at/above the
 *  ancient ceiling, linear between. */
export function staleToIntensity(ageDays: number | null | undefined): number

export interface AttachGitSignalsOptions {
  world: { agents: Array<{
    gitPath?: string
    setFreshness?: (ageDays: number | null) => void
    setChurn?: (intensity: number) => void
    /** THREE.Object3D-ish — only .add()/.remove() are ever called on it.
     *  Absent (as in every existing test fixture) means the churn-vis
     *  desk props are skipped entirely, same "no DOM, no problem"
     *  contract the rest of this file already keeps. */
    root?: { add: (...o: unknown[]) => unknown; remove: (...o: unknown[]) => unknown }
    scale?: number
  }> }
  zones: { setOwner?: (zoneName: string, owner: string) => void }
  /** Optional sink for the full shortlog body per zone (shares, runner-up),
   *  not just the top name `zones.setOwner` gets. See zoneowner.js. */
  ownership?: { set?: (zoneName: string, data: GitShortlogBody | null | undefined) => void }
  fetchFn?: typeof fetch
  intervalMs?: number
  zoneDirs?: Record<string, string>
}

export function attachGitSignals(opts: AttachGitSignalsOptions): {
  /** Poll every git endpoint now instead of waiting for the interval. */
  poll(): Promise<void>
  /** Per-frame step, driven by office.html's one shared frame loop —
   *  throttled internally to ~20Hz, safe to call every frame. */
  tick(dt: number): void
  /** Disposes one agent's desk-fx (heat/cold groups + their own geometry)
   *  and drops it from the internal map. Call from despawnLive — stop()
   *  alone only tears the whole room down. */
  forget(a: AttachGitSignalsOptions['world']['agents'][number]): void
  stop(): void
  readonly churnMode: ChurnMode
  setChurnMode(mode: ChurnMode): void
}
