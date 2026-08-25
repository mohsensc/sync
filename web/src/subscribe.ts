import type { CharacterRegistry } from './characters.js'

interface PresenceMessage {
  type: string
  agent: string
  human: string
  verb: string
  region: { path: string; symbol: string | null }
  rung?: number
  /** Relay clock, in seconds, on every presence frame it sends. */
  ts?: number
}

function isPresence(m: unknown): m is PresenceMessage {
  if (typeof m !== 'object' || m === null) return false
  const x = m as Record<string, unknown>
  return (
    x.type === 'presence' &&
    typeof x.agent === 'string' &&
    typeof x.human === 'string' &&
    typeof x.verb === 'string' &&
    typeof x.region === 'object' && x.region !== null &&
    typeof (x.region as Record<string, unknown>).path === 'string'
  )
}

// The join reply (relaysrv/relay.go's sendLeaseSnapshot) is type "leases",
// carrying recent activity as a bare `presence` array — entries with the
// same agent/human/verb/region fields a live presence frame has, just
// without the envelope. Mirrors live.js's isLeasesSnapshot: without this, a
// room that's already busy renders empty until the next live event.
interface LeasesMessage {
  type: string
  presence: unknown[]
}

function isLeasesSnapshot(m: unknown): m is LeasesMessage {
  if (typeof m !== 'object' || m === null) return false
  const x = m as Record<string, unknown>
  return x.type === 'leases' && Array.isArray(x.presence)
}

export class Subscription {
  constructor(private registry: CharacterRegistry) {}

  /** Malformed input is dropped, never fatal — the world must survive a bad
   *  frame from the relay without going blank. */
  onMessage(msg: unknown, now: number): void {
    if (isPresence(msg)) {
      this.#applyPresence(msg, now)
      return
    }
    if (isLeasesSnapshot(msg)) {
      for (const entry of msg.presence) {
        const p = { type: 'presence', ...(entry as object) }
        if (isPresence(p)) this.#applyPresence(p, now)
      }
    }
  }

  #applyPresence(msg: PresenceMessage, now: number): void {
    // Stamp with the relay's own clock, not local arrival.
    //
    // The entries replayed inside the join-time leases snapshot are not
    // fresh — they are whatever activity is still inside the relay's
    // presence TTL when a viewer joins, so up to ~30s old already. Stamping
    // those with `now` handed them a second, full TTL on top of what they
    // had already spent, and a character that went quiet just before a
    // second viewer opened the room stayed on screen for up to twice
    // PRESENCE_TTL_MS. CharacterRegistry.expire cannot correct for it: it
    // only ever compares against the same client clock.
    //
    // Clamped to `now` rather than trusted outright — a relay clock running
    // ahead of the browser's must not make an entry look fresher than the
    // moment it actually arrived. Same fix office/live.js's onPresence
    // already carries; this parallel implementation never got it.
    const lastSeen = typeof msg.ts === 'number' && Number.isFinite(msg.ts)
      ? Math.min(now, msg.ts * 1000)
      : now
    this.registry.upsert(msg.agent, msg.human, msg.verb, msg.region.path, lastSeen)
  }

  // This page has no pointer picking on the capsule viewer (that's
  // office/*.js's interact.js, a different scene) so there is nothing here
  // to ever call anything but this default — emphasis used to carry a
  // hover/contest system with no caller anywhere in src/, which is exactly
  // the dead surface the no-dead-code rule means. Deleted rather than
  // wired up: there's no trivial hook point to wire it to.
  emphasis(_agent: string): number {
    return 1
  }
}
