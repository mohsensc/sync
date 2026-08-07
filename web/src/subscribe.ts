import type { CharacterRegistry } from './characters.js'

const DIMMED = 0.25

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

export class Subscription {
  #hovered: string | null = null
  #contested = new Set<string>()

  constructor(private registry: CharacterRegistry, private myHuman: string) {}

  /** Malformed input is dropped, never fatal — the world must survive a bad
   *  frame from the relay without going blank. */
  onMessage(msg: unknown, now: number): void {
    if (!isPresence(msg)) return
    this.registry.upsert(msg.agent, msg.human, msg.verb, msg.region.path, now)
    if ((msg.rung ?? 0) >= 3) this.#contested.add(msg.agent)
    else this.#contested.delete(msg.agent)
  }

  setHover(human: string | null): void {
    this.#hovered = human
  }

  /** With twenty-plus characters on screen, the world is beautiful but busy.
   *  Dimming everyone else is what makes your own agents findable. */
  emphasis(agent: string): number {
    if (this.#hovered === null) return 1
    const c = this.registry.all().find((x) => x.agent === agent)
    if (!c) return 1
    return c.human === this.#hovered ? 1 : DIMMED
  }

  /** Who to hover when nobody has been picked yet. */
  mine(): string[] {
    return this.registry.byHuman(this.myHuman).map((c) => c.agent)
  }

  contested(): string[] {
    return [...this.#contested]
  }
}
