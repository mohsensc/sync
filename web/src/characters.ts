import { hairFor } from './palette.js'
import { ZONES, zoneFor, type ZoneName } from './zones.js'

export const PRESENCE_TTL_MS = 30_000
const WALK_SPEED = 4 // world units per second

export interface CharacterState {
  agent: string
  human: string
  hair: string
  zone: ZoneName
  x: number
  z: number
  targetX: number
  targetZ: number
  lastSeen: number
}

/** Deterministic jitter so two characters in one zone do not stand inside
 *  each other, without needing collision resolution. */
function jitter(seed: string, spread: number): number {
  let h = 0
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) >>> 0
  return ((h % 1000) / 1000 - 0.5) * spread
}

export class CharacterRegistry {
  #chars = new Map<string, CharacterState>()

  upsert(agent: string, human: string, verb: string, path: string, now: number): void {
    const zone = zoneFor(verb, path)
    const box = ZONES[zone]
    const targetX = box.x + jitter(agent + 'x', box.w * 0.7)
    const targetZ = box.z + jitter(agent + 'z', box.d * 0.7)

    const existing = this.#chars.get(agent)
    if (existing) {
      existing.zone = zone
      existing.targetX = targetX
      existing.targetZ = targetZ
      existing.lastSeen = now
      return
    }

    this.#chars.set(agent, {
      agent, human, hair: hairFor(human), zone,
      // Enter from reception so arrivals read as arrivals.
      x: ZONES.reception.x, z: ZONES.reception.z,
      targetX, targetZ, lastSeen: now,
    })
  }

  expire(now: number): void {
    for (const [agent, c] of this.#chars) {
      if (now - c.lastSeen > PRESENCE_TTL_MS) this.#chars.delete(agent)
    }
  }

  step(dtSeconds: number): void {
    for (const c of this.#chars.values()) {
      const dx = c.targetX - c.x
      const dz = c.targetZ - c.z
      const dist = Math.hypot(dx, dz)
      if (dist < 0.01) continue
      const move = Math.min(dist, WALK_SPEED * dtSeconds)
      c.x += (dx / dist) * move
      c.z += (dz / dist) * move
    }
  }

  all(): CharacterState[] {
    return [...this.#chars.values()]
  }

  byHuman(human: string): CharacterState[] {
    return this.all().filter((c) => c.human === human)
  }
}
