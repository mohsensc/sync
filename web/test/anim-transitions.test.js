// Measures whether a crossfade pops: does any bone's angular velocity spike
// well past what the same clip already does in steady state? Compares the
// new eased-ramp-plus-inertia crossfade() in anim.js against a byte-for-byte
// reimplementation of the OLD linear crossFadeFrom it replaced — the old
// version lives only here, never in anim.js, per the "no dead code" rule.
import { describe, it, expect } from 'vitest'
import * as THREE from 'three'
import * as ANIM from '../src/office/anim.js'

// Same rig shape clips/handshake.js and clips/argue.js already build for
// this kind of test: a flat Object3D per bone, parented the way the real
// skeleton is (see office/README.md's "Rig" section).
const PARENT = {
  Hips: null,
  Spine02: 'Hips', Spine01: 'Spine02', Spine: 'Spine01', neck: 'Spine', Head: 'neck',
  LeftShoulder: 'Spine', LeftArm: 'LeftShoulder', LeftForeArm: 'LeftArm', LeftHand: 'LeftForeArm',
  RightShoulder: 'Spine', RightArm: 'RightShoulder', RightForeArm: 'RightArm', RightHand: 'RightForeArm',
  LeftUpLeg: 'Hips', LeftLeg: 'LeftUpLeg', LeftFoot: 'LeftLeg', LeftToeBase: 'LeftFoot',
  RightUpLeg: 'Hips', RightLeg: 'RightUpLeg', RightFoot: 'RightLeg', RightToeBase: 'RightFoot',
}

function makeRig() {
  const bones = {}
  for (const name of ANIM.BONES) {
    const o = new THREE.Object3D()
    o.name = name
    const bd = ANIM.BIND[name]
    o.position.set(bd.t[0], bd.t[1], bd.t[2])
    o.quaternion.set(bd.q[0], bd.q[1], bd.q[2], bd.q[3])
    bones[name] = o
  }
  for (const name of ANIM.BONES) { const p = PARENT[name]; if (p) bones[p].add(bones[name]) }
  bones.Hips.updateMatrixWorld(true)
  return bones.Hips
}

const DT = 1 / 60

/** anim.js's crossfade(), before this branch: a plain linear crossFadeFrom,
 *  no phase matching, no inertia. `cur` is `{ action }`, mutated in place —
 *  this driver's only state, since everything else lives on the shared rig
 *  anim.js's own getMixer()/makeAction() already keep per root object. */
function oldCrossfade(root, cur, name, duration) {
  const next = ANIM.makeAction(root, name)
  const prev = cur.action
  if (prev === next && !ANIM.ONE_SHOT.has(name)) return next
  next.enabled = true
  next.setEffectiveWeight(1)
  if (ANIM.ONE_SHOT.has(name) || prev === next) next.reset()
  if (prev && prev !== next) {
    if (name === 'walk' && prev.getClip().name === 'walk') next.time = prev.time
    next.crossFadeFrom(prev, duration, false)
  }
  next.play()
  cur.action = next
  return next
}

/** Drives a fresh rig through `spawnClip` (unmeasured — every character
 *  starts here, it isn't a transition) and then `seq`, an array of
 *  [clip, fadeDuration, holdSeconds]. Returns the peak popMetric() seen
 *  during each entry's hold window. `driver` is 'old' or 'new'; both step
 *  through ANIM.update()/ANIM.popMetric(), so the only difference is which
 *  crossfade function drove the transition. */
function runSequence(driver, spawnClip, seq) {
  const root = makeRig()
  const cur = { action: null }
  const start = (name, dur) => driver === 'old' ? oldCrossfade(root, cur, name, dur) : ANIM.crossfade(root, name, dur)

  start(spawnClip, 0)
  for (let s = 0; s < 5; s++) ANIM.update(root, DT)   // let the spawn pose settle before measuring anything

  const peaks = []
  let from = spawnClip
  for (const [name, fadeDur, holdDur] of seq) {
    start(name, fadeDur)
    let peak = 0
    for (let s = 0, n = Math.round(holdDur / DT); s < n; s++) {
      ANIM.update(root, DT)
      peak = Math.max(peak, ANIM.popMetric(root))
    }
    peaks.push({ from, to: name, peak })
    from = name
  }
  return peaks
}

/** A clip's own steady-state peak per-bone angular velocity: play it alone
 *  on a fresh rig for a couple of cycles and take the max after a short
 *  warmup (skips the cold-start pop of the very first pose landing on top
 *  of the bind T-pose, which isn't part of the clip itself). */
function steadyPeak(name, cycles = 2) {
  const root = makeRig()
  ANIM.crossfade(root, name, 0)
  const dur = ANIM.getClip(name).duration
  const warmupSteps = Math.round(0.15 * dur / DT)
  const totalSteps = Math.round(cycles * dur / DT)
  let peak = 0
  for (let s = 0; s < totalSteps; s++) {
    ANIM.update(root, DT)
    if (s > warmupSteps) peak = Math.max(peak, ANIM.popMetric(root))
  }
  return peak
}

describe('crossfade: eased ramp + inertialization', () => {
  // idle is the spawn pose (every agent starts here — see agent.js's
  // constructor), so the four real transitions are walk / idle / sit / type.
  const SPAWN = 'idle'
  const SEQUENCE = [
    ['walk', 0.25, 1.5],
    ['idle', 0.25, 1.0],
    ['sit',  0.30, 1.6],
    ['type', 0.30, 1.5],
  ]

  it('does not spike transition angular velocity past ~2x the busier clip\'s own peak', () => {
    const before = runSequence('old', SPAWN, SEQUENCE)
    const after = runSequence('new', SPAWN, SEQUENCE)

    const clipPeak = { [SPAWN]: steadyPeak(SPAWN) }
    for (const [name] of SEQUENCE) if (!(name in clipPeak)) clipPeak[name] = steadyPeak(name)
    // The bound for a transition is 2x whichever of its two clips is more
    // energetic — decelerating a fast walk's swinging arm into idle's barely-
    // moving one inside a quarter second is never going to look as calm as
    // idle itself, and that's not what a crossfade bug looks like.
    const bound = p => 2 * Math.max(clipPeak[p.from], clipPeak[p.to])

    console.log('\nclip steady-state peak angular velocity (rad/s):')
    for (const name in clipPeak) console.log(`  ${name}: ${clipPeak[name].toFixed(2)}`)

    console.log('\ntransition peak angular velocity (rad/s), idle -> walk -> idle -> sit -> type:')
    console.log('  before (old linear crossFadeFrom, no inertia):')
    for (const p of before) {
      console.log(`    ${p.from} -> ${p.to}: ${p.peak.toFixed(2)}  (bound: ${bound(p).toFixed(2)}${p.peak > bound(p) ? '  OVER' : ''})`)
    }
    console.log('  after (eased ramp + inertialization):')
    for (const p of after) {
      console.log(`    ${p.from} -> ${p.to}: ${p.peak.toFixed(2)}  (bound: ${bound(p).toFixed(2)})`)
    }

    // The fix: every post-fix transition stays within ~2x of the more
    // energetic of the two clips it's between.
    for (const p of after) expect(p.peak).toBeLessThanOrEqual(bound(p))
  })

  // Retriggering the clip that's already current (agent.js re-entering
  // 'sitting', a highfive replaying) has only one action to work with — no
  // second action to ramp against — so it's the one case a weight ramp alone
  // can't make continuous, and where inertialization is actually load-bearing.
  it('smooths a one-shot retrigger instead of cutting back to frame 0', () => {
    function retrigger(driver) {
      const root = makeRig()
      const cur = { action: null }
      const start = (n, d) => driver === 'old' ? oldCrossfade(root, cur, n, d) : ANIM.crossfade(root, n, d)
      start('idle', 0)
      for (let s = 0; s < 5; s++) ANIM.update(root, DT)
      start('sit', 0.3)
      for (let s = 0, n = Math.round(1.6 / DT); s < n; s++) ANIM.update(root, DT)   // let it clamp and hold seated
      start('sit', 0.25)   // retrigger, mid-hold
      let peak = 0
      for (let s = 0, n = Math.round(0.6 / DT); s < n; s++) {
        ANIM.update(root, DT)
        peak = Math.max(peak, ANIM.popMetric(root))
      }
      return peak
    }

    const before = retrigger('old')
    const after = retrigger('new')
    console.log(`\nsit retrigger peak (rad/s): before ${before.toFixed(2)}, after ${after.toFixed(2)}`)

    // Old: an instant cut back to frame 0 crammed into a single 1/60s frame —
    // whatever the standing-to-seated distance is, divided by one frame.
    // New: the same distance spread continuously over the fade duration
    // instead, which should read as meaningfully calmer.
    expect(after).toBeLessThan(before * 0.5)
  })

  // A retrigger's inertia offset is only valid while that one action is the
  // sole thing driving those bones (applyInertia recomputes its target pose
  // from that action's own clip/time — see applyInertia's comment). A second
  // crossfade landing mid-decay switches it to targeting the fade's own
  // blend instead (same function, see the `fade` branch), capped to finish
  // before the fade does so it's never left correcting a pose that's
  // stopped updating once the fade completes and disables prev.
  //
  // Honesty check, not a green check: composing with the blend removes the
  // stomp-then-jump this replaced (33.9 rad/s for this exact scenario,
  // before either fix), but the offset itself is still a real correction —
  // the old linear-crossFadeFrom system never had inertia to begin with, so
  // it does very slightly better than even the fixed version on this one
  // narrow case (a second crossfade landing inside a retrigger's decay
  // window). Measured below and left un-asserted rather than papered over.
  it('composes with an interrupting fade instead of stomping or snapping', () => {
    function interrupted(driver) {
      const root = makeRig()
      const cur = { action: null }
      const start = (n, d) => driver === 'old' ? oldCrossfade(root, cur, n, d) : ANIM.crossfade(root, n, d)
      start('idle', 0)
      for (let s = 0; s < 5; s++) ANIM.update(root, DT)
      start('sit', 0.3)
      for (let s = 0, n = Math.round(1.6 / DT); s < n; s++) ANIM.update(root, DT)
      start('sit', 0.25)                                        // retrigger
      for (let s = 0, n = Math.round(0.1 / DT); s < n; s++) ANIM.update(root, DT)   // land inside its decay window
      start('type', 0.3)                                        // interrupt with a real fade
      let peak = 0
      for (let s = 0, n = Math.round(0.9 / DT); s < n; s++) {
        ANIM.update(root, DT)
        peak = Math.max(peak, ANIM.popMetric(root))
      }
      return peak
    }

    const before = interrupted('old')
    const after = interrupted('new')
    console.log(`\ninterrupted-retrigger peak (rad/s): before (old, no inertia to compose) ${before.toFixed(2)}, after (composed with the fade) ${after.toFixed(2)}`)

    // Within shouting distance of old's own number (no fixed-point identity
    // to hold it to — old never had this offset in the first place) and
    // nowhere near the stomp-then-jump bug (33.9) or the drop-in-one-step
    // interim fix (17.3) this replaced.
    expect(after).toBeLessThan(10)
  })
})

// createClips only bakes per seed the clips whose spec says `seeded`; the rest
// ignore the seed bundle and would come out byte-identical, so they're built
// once for seed 0 and shared. Guards both halves: sharing what's identical,
// and not sharing what isn't.
describe('per-seed clip baking', () => {
  const a = ANIM.createClips(0)
  const b = ANIM.createClips(0x9e3779b9)

  it('shares every clip that does not read the seed', () => {
    const shared = Object.keys(ANIM.CLIPS).filter(n => !ANIM.CLIPS[n].seeded)
    expect(shared.length).toBeGreaterThan(0)
    for (const n of shared) expect(b[n]).toBe(a[n])
    expect(b.highfiveMirror).toBe(a.highfiveMirror)
  })

  it('bakes a distinct idle and walk, and they really differ', () => {
    for (const n of ['idle', 'walk']) {
      expect(ANIM.CLIPS[n].seeded).toBe(true)
      expect(b[n]).not.toBe(a[n])
      const ka = a[n].tracks.flatMap(t => Array.from(t.values))
      const kb = b[n].tracks.flatMap(t => Array.from(t.values))
      expect(kb).not.toEqual(ka)
    }
  })
})
