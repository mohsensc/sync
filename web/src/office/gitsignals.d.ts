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

export interface AttachGitSignalsOptions {
  world: { agents: Array<{
    gitPath?: string
    setFreshness?: (ageDays: number | null) => void
    setChurn?: (intensity: number) => void
  }> }
  zones: { setOwner?: (zoneName: string, owner: string) => void }
  fetchFn?: typeof fetch
  intervalMs?: number
  zoneDirs?: Record<string, string>
}

export function attachGitSignals(opts: AttachGitSignalsOptions): { tick(): Promise<void>; stop(): void }
