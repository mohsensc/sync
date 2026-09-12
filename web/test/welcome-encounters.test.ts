import { describe, expect, it } from 'vitest'
import { AnimationClip, AnimationMixer, Group } from 'three'
import { createEncounters, type SocialWalker } from '../src/welcome-encounters.js'

function walker(x: number, z: number): SocialWalker {
  const root = new Group()
  root.position.set(x, 0, z)
  const mixer = new AnimationMixer(root)
  const action = (name: string) => mixer.clipAction(new AnimationClip(name, 2, []))
  const actions = { walk: action('walk'), idle: action('idle'), highfive: action('highfive'), argue: action('argue'), argueReact: action('argueReact') }
  actions.walk.play()
  return { root, body: new Group(), mixer, actions, action: actions.walk, direction: 1, progress: 0, pace: 1, remaining: 5, elapsed: 0, activity: 'walk' }
}

describe('welcome encounters', () => {
  it('stages synchronized contact, preserves depth lanes, then separates the pair', () => {
    const left = walker(-2, 0), right = walker(2, -3), bystander = walker(20, -6)
    const update = createEncounters([left, right, bystander], 0.92)
    let contact = false
    let departed = false
    for (let frame = 0; frame < 1200; frame++) {
      const busy = update(1 / 30, 12)
      expect(busy.has(bystander)).toBe(false)
      expect([left.root.position.z, right.root.position.z]).toEqual([0, -3])
      if (left.action === left.actions.highfive) {
        contact = true
        expect(right.action).toBe(right.actions.highfive)
        expect(right.root.position.x - left.root.position.x).toBeCloseTo(0.92, 5)
        expect(left.action.time).toBeCloseTo(right.action.time, 5)
      }
      if (contact && !busy.size) {
        expect(left.direction).toBe(-1)
        expect(right.direction).toBe(1)
        departed = true
        break
      }
    }
    expect(contact && departed).toBe(true)
  })

  it('occasionally alternates to a paired argument with different roles', () => {
    const left = walker(-1, 0), right = walker(1, -3)
    const update = createEncounters([left, right], 0.92)
    let argued = false
    for (let frame = 0; frame < 2400; frame++) {
      update(1 / 30, 12)
      if (left.action === left.actions.argue) {
        expect(right.action).toBe(right.actions.argueReact)
        expect(right.root.position.x - left.root.position.x).toBeCloseTo(1.35, 5)
        argued = true
        break
      }
    }
    expect(argued).toBe(true)
  })

  it('keeps a performing pair on-screen and in contact when the viewport narrows', () => {
    const left = walker(5, 0), right = walker(8, -3)
    const update = createEncounters([left, right], 0.92)
    for (let frame = 0; frame < 1200 && left.action !== left.actions.highfive; frame++) update(1 / 30, 24)
    expect(left.action).toBe(left.actions.highfive)
    update(0, 6)
    expect(Math.abs(left.root.position.x)).toBeLessThan(3)
    expect(Math.abs(right.root.position.x)).toBeLessThan(3)
    expect(right.root.position.x - left.root.position.x).toBeCloseTo(0.92, 5)
  })
})
