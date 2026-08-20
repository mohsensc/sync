import type { CharacterRegistry } from './characters.js'

interface PresenceMessage {
  type: string
  agent: string
  human: string
  verb: string
  region: { path: string; symbol: string | null }
  rung?: number
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
    this.registry.upsert(msg.agent, msg.human, msg.verb, msg.region.path, now)
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
