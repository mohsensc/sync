import { describe, it, expect, beforeEach } from 'vitest'
import { ZONES, claimSlot, releaseSlots, resetSlots } from '../src/office/zones.js'

// #111: claimSlot fires on every presence update, not just zone changes.
// Before the fix, moving zones left the old zone's slot claimed forever —
// only despawn called releaseSlots. These pin the three behaviours the fix
// has to get right: old zone frees on move, same-zone re-claims don't hop
// seats, and a full pool still falls back to ringing the centre.
describe('zone slot booking', () => {
  beforeEach(() => resetSlots())

  it('frees the old zone slot when an agent moves zones', () => {
    const s1 = claimSlot('vault', 'a1')
    claimSlot('vault', 'ghost')

    claimSlot('desks', 'a1') // a1 moves on

    // a1's old seat is claimable again, not stuck as a ghost claim.
    expect(claimSlot('vault', 'b1').index).toBe(s1.index)
  })

  it('keeps the same slot on a same-zone re-claim', () => {
    const first = claimSlot('vault', 'a1')
    const again = claimSlot('vault', 'a1')
    expect(again.index).toBe(first.index)
    expect(again.pos).toEqual(first.pos)
  })

  it('still rings the centre once a zone pool is full', () => {
    const pool = ZONES.vault.slots.length
    for (let i = 0; i < pool; i++) claimSlot('vault', `agent-${i}`)

    const overflow = claimSlot('vault', 'latecomer')
    expect(overflow.index).toBe(-1)

    // ringed position sits on the zone's radius, not on a real slot mark
    const [cx, cz] = ZONES.vault.at
    const dist = Math.hypot(overflow.pos[0] - cx, overflow.pos[1] - cz)
    expect(dist).toBeCloseTo(ZONES.vault.r, 5)
  })
})
