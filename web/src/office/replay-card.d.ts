// Hand-written types for replay-card.js, same pattern as caption.d.ts.

import type { ReelParty, Rung } from './reel.js'

export type ReplayCardVariant = 'split' | 'strip'

export interface ReplayCardShowInfo {
  a: ReelParty
  b: ReelParty
  rung: Rung
  label: string
}

export interface ReplayCard {
  show(info: ReplayCardShowInfo): void
  hide(): void
  variant: ReplayCardVariant | null
}

export function createReplayCard(
  container: HTMLElement,
  variant: string | null | undefined
): ReplayCard
