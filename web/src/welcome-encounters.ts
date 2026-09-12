import type { AnimationAction, AnimationMixer, Group } from 'three'

export interface SocialWalker {
  root: Group
  body: Group
  mixer: AnimationMixer
  actions: Record<'walk' | 'idle' | 'highfive' | 'argue' | 'argueReact', AnimationAction>
  action: AnimationAction
  direction: number
  progress: number
  pace: number
  remaining: number
  elapsed: number
  activity: 'walk' | 'wave' | 'look'
}

function play(walker: SocialWalker, action: AnimationAction) {
  if (walker.action === action) return
  action.reset().setEffectiveWeight(1).play()
  walker.action.crossFadeTo(action, 0.3, false)
  walker.action = action
}

// Contact is staged in screen space. The orthographic camera lets the palms
// meet visually while each figure retains its permanent, nonintersecting z lane.
export function createEncounters(walkers: SocialWalker[], highfiveSpacing: number) {
  let cooldown = 9
  let count = 0
  let pair: { left: SocialWalker; right: SocialWalker; phase: 'approach' | 'perform' | 'release'; time: number; kind: 'highfive' | 'argue'; center: number } | null = null
  return (dt: number, width: number): Set<SocialWalker> => {
    cooldown -= dt
    if (!pair && cooldown <= 0) {
      const visible = walkers.filter(w => Math.abs(w.root.position.x) < width / 2 - 0.8).sort((a, b) => a.root.position.x - b.root.position.x)
      let best: [SocialWalker, SocialWalker] | null = null
      let distance = Infinity
      for (let i = 1; i < visible.length; i++) {
        const gap = visible[i].root.position.x - visible[i - 1].root.position.x
        if (gap < distance) { best = [visible[i - 1], visible[i]]; distance = gap }
      }
      if (best) {
        pair = { left: best[0], right: best[1], center: (best[0].root.position.x + best[1].root.position.x) / 2, phase: 'approach', time: 0, kind: count++ % 2 === 0 ? 'highfive' : 'argue' }
      }
    }
    if (!pair) return new Set()
    const participants = [pair.left, pair.right]
    const busy = new Set(participants)
    const spacing = pair.kind === 'highfive' ? highfiveSpacing : 1.35
    // Re-clamp after a resize so an encounter cannot be stranded off-screen.
    const previousCenter = pair.center
    pair.center = Math.max(-width / 2 + 1.25, Math.min(width / 2 - 1.25, pair.center))
    if (pair.phase !== 'approach') {
      participants.forEach(walker => { walker.root.position.x += pair!.center - previousCenter })
    }
    let ready = true
    participants.forEach((walker, index) => {
      const target = pair!.center + (index === 0 ? -1 : 1) * spacing / 2
      const delta = target - walker.root.position.x
      const moving = pair!.phase === 'approach' && Math.abs(delta) > 0.015
      const heading = moving ? Math.sign(delta) * Math.PI / 2 : (index === 0 ? 1 : -1) * Math.PI / 2
      walker.root.rotation.y += (heading - walker.root.rotation.y) * Math.min(1, dt * 7)
      if (pair!.phase === 'approach') {
        play(walker, moving ? walker.actions.walk : walker.actions.idle)
        const step = Math.abs(heading - walker.root.rotation.y) < 0.25 ? Math.min(Math.abs(delta), dt * 0.85) : 0
        walker.root.position.x += Math.sign(delta) * step
        if (!moving) walker.root.position.x = target
        if (moving || Math.abs(heading - walker.root.rotation.y) > 0.03) ready = false
      }
      walker.body.rotation.z = 0
      walker.root.position.y = 0
      walker.pace = 0
      walker.progress = (walker.root.position.x + (width + 2) / 2) / (width + 2)
    })
    pair.time += dt
    if (pair.phase === 'approach' && ready) {
      pair.phase = 'perform'
      pair.time = 0
      participants.forEach((walker, index) => play(walker, pair!.kind === 'highfive' ? walker.actions.highfive : index === 0 ? walker.actions.argue : walker.actions.argueReact))
    } else if (pair.phase === 'perform' && pair.time >= (pair.kind === 'highfive' ? 1.8 : 4.8)) {
      pair.phase = 'release'
      pair.time = 0
      participants.forEach(walker => play(walker, walker.actions.idle))
    } else if (pair.phase === 'release' && pair.time >= 0.6) {
      participants.forEach((walker, index) => {
        walker.direction = index === 0 ? -1 : 1
        walker.activity = 'walk'
        walker.remaining = 7 + index * 2
        walker.elapsed = 0
        play(walker, walker.actions.walk)
      })
      pair = null
      cooldown = 14 + Math.random() * 10
    }
    participants.forEach(walker => walker.mixer.update(dt))
    return busy
  }
}
