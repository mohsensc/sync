// Verifies the three problems the adversarial review found in #settle
// (agent.js): unbounded yaw slew on a big heading error, a foot-slide-speed
// position glide, and a goTo promise that never settled when superseded.
// Ported from scratch/fluid-motion-check.mjs and scratch/adv-agent.mjs,
// which did the original from-scratch measurement of these numbers.
import { describe, it, expect, beforeAll } from 'vitest'
import * as THREE from 'three'

// agent.js's badge sprite draws into a <canvas> for its label texture — not
// exercised by anything here (no rendering), so a minimal stand-in is
// enough to let Agent's constructor run under vitest's default node env.
beforeAll(() => {
  globalThis.document = {
    createElement: () => ({
      width: 0, height: 0,
      getContext: () => ({
        clearRect(){}, beginPath(){}, moveTo(){}, lineTo(){}, quadraticCurveTo(){},
        closePath(){}, fill(){}, stroke(){}, fillText(){}, measureText: () => ({ width: 0 }),
      }),
    }),
  }
})

const ANIM = await import('../src/office/anim.js')
const { World, createAgent, TUNING } = await import('../src/office/agent.js')
const { spacingFor } = await import('../src/office/highfive.js')

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
const wrapPi = a => Math.atan2(Math.sin(a), Math.cos(a))

describe('agent settle: yaw rate bound (problem 1)', () => {
  it('never exceeds turnIdle even off a pi heading error, and keeps the walk clip live until pivotExit', async () => {
    const a = createAgent({ root: makeRig(), id: 'y1', pos: [0, 3], yaw: 0 })

    let maxYawRateWhileSlow = 0
    let framesAboveExit = 0
    let sawIdleAboveExit = false
    let prevYaw = a.yaw
    let settled = false
    // Start facing straight at the target (pos [0,3], yaw 0 -> external
    // forward is -Z, which points right at (0,0)) so the walk approach
    // itself does no turning and the whole pi error lands on #settle,
    // same shape as scratch/adv-agent.mjs's case A, which is what actually
    // saturated the turnIdle clamp when this was checked by hand.
    a.goTo(0, 0, { yaw: Math.PI }).then(() => { settled = true })
    await Promise.resolve()

    let steps = 0
    while (!settled && steps < 60 * 20) {
      a.update(DT)
      steps++
      await Promise.resolve()

      const yawRate = Math.abs(wrapPi(a.yaw - prevYaw)) / DT
      prevYaw = a.yaw
      if (a.speed < 0.02) maxYawRateWhileSlow = Math.max(maxYawRateWhileSlow, yawRate)

      if (a._settle) {
        const remaining = Math.abs(wrapPi(Math.PI - a.yaw))
        if (remaining > TUNING.pivotExit) {
          framesAboveExit++
          if (a.clip !== 'walk') sawIdleAboveExit = true
        }
      }
    }

    expect(settled).toBe(true)
    expect(maxYawRateWhileSlow).toBeLessThanOrEqual(TUNING.turnIdle + 1e-6)
    // The pi heading error in this scenario guarantees the settle phase
    // spends real time above pivotExit — a low frame count here would mean
    // the geometry isn't actually exercising the turn-in-place branch, and
    // the assertions above would be passing vacuously. At turnIdle
    // (2.4 rad/s) closing pi radians takes ~1.3s, comfortably more than a
    // couple of frames at 60Hz.
    expect(framesAboveExit).toBeGreaterThan(30)
    expect(sawIdleAboveExit).toBe(false)
    expect(Math.abs(a.pos.x)).toBe(0)
    expect(Math.abs(a.pos.z)).toBe(0)
    expect(Math.abs(wrapPi(a.yaw - Math.PI))).toBeLessThan(1e-6)
  })
})

describe('agent settle: position glide speed (problem 2)', () => {
  async function maxIdleClipSpeed(a, tx, tz, opts) {
    let settled = false
    a.goTo(tx, tz, opts).then(() => { settled = true })
    await Promise.resolve()
    let maxSpeed = 0
    let prev = [a.pos.x, a.pos.z]
    let steps = 0
    while (!settled && steps < 60 * 20) {
      // Sample "is this frame's motion under the idle clip" from BEFORE the
      // update: #arrive flips clip 'walk' -> 'idle' partway through the very
      // frame it fires in, and that one frame's position delta is still the
      // tail of the walk-speed approach (up to TUNING.arriveSpeed), not the
      // idle-clip glide — checking the clip after the fact wrongly folds
      // that into the glide-speed measurement. See scratch/adv-agent.mjs,
      // which the same fix was ported from.
      const wasGliding = a.clip === 'idle'
      a.update(DT)
      steps++
      await Promise.resolve()
      const speed = Math.hypot(a.pos.x - prev[0], a.pos.z - prev[1]) / DT
      prev = [a.pos.x, a.pos.z]
      if (wasGliding) maxSpeed = Math.max(maxSpeed, speed)
    }
    expect(settled).toBe(true)
    return maxSpeed
  }

  it('sendToFloor-style arrival (no yaw) stays under 0.05 m/s under idle', async () => {
    const a = createAgent({ root: makeRig(), id: 'p1', pos: [0, -3], yaw: 0 })
    const s = await maxIdleClipSpeed(a, 0, 0, {})
    expect(s).toBeLessThanOrEqual(0.05)
    expect(a.pos.x).toBe(0)
    expect(a.pos.z).toBe(0)
  })

  it('sitAt-style arrival (yaw pi) stays under 0.05 m/s under idle', async () => {
    const a = createAgent({ root: makeRig(), id: 'p2', pos: [0, -3], yaw: 0 })
    const s = await maxIdleClipSpeed(a, 0, 0, { yaw: Math.PI })
    expect(s).toBeLessThanOrEqual(0.05)
    expect(a.pos.x).toBe(0)
    expect(a.pos.z).toBe(0)
    expect(Math.abs(wrapPi(a.yaw - Math.PI))).toBeLessThan(1e-6)
  })

  it('highfive pair approach stays under 0.05 m/s under idle for both agents', async () => {
    const world = new World()
    const a = createAgent({ root: makeRig(), id: 'hf1', pos: [-1, 0], yaw: 0 })
    const b = createAgent({ root: makeRig(), id: 'hf2', pos: [1, 0.3], yaw: Math.PI })
    world.add(a); world.add(b)
    world.highfive(a, b)

    let maxSpeed = 0
    let prevA = [a.pos.x, a.pos.z], prevB = [b.pos.x, b.pos.z]
    let steps = 0
    while (world.encounters[0] && world.encounters[0].phase !== 'done' && steps < 60 * 20) {
      // See maxIdleClipSpeed above for why this is sampled before update().
      const aWasGliding = a.clip === 'idle', bWasGliding = b.clip === 'idle'
      world.update(DT)
      steps++
      await Promise.resolve()
      const sa = Math.hypot(a.pos.x - prevA[0], a.pos.z - prevA[1]) / DT
      const sb = Math.hypot(b.pos.x - prevB[0], b.pos.z - prevB[1]) / DT
      prevA = [a.pos.x, a.pos.z]; prevB = [b.pos.x, b.pos.z]
      if (aWasGliding) maxSpeed = Math.max(maxSpeed, sa)
      if (bWasGliding) maxSpeed = Math.max(maxSpeed, sb)
    }
    expect(maxSpeed).toBeLessThanOrEqual(0.05)
  })
})

describe('highfive pair spacing (problem 2 regression guard)', () => {
  it('lands exactly on spacingFor(height) the instant the highfive clip starts', async () => {
    const world = new World()
    const a = createAgent({ root: makeRig(), id: 'hf3', pos: [-1, 0], yaw: 0, height: 1.68 })
    const b = createAgent({ root: makeRig(), id: 'hf4', pos: [1, 0.3], yaw: Math.PI, height: 1.68 })
    world.add(a); world.add(b)
    world.highfive(a, b)

    // main's World phase machine calls the paired-clip phase 'active', not
    // 'play' (the old base's name for it) — see agent.js's #step/#beginActive.
    let spacingAtPlay = null
    let steps = 0
    while (spacingAtPlay == null && steps < 60 * 20) {
      const wasActive = world.encounters[0] && world.encounters[0].phase === 'active'
      world.update(DT)
      steps++
      await Promise.resolve()
      const enc = world.encounters[0]
      if (enc && enc.phase === 'active' && !wasActive) {
        spacingAtPlay = Math.hypot(a.pos.x - b.pos.x, a.pos.z - b.pos.z)
      }
    }
    expect(spacingAtPlay).not.toBeNull()
    expect(Math.abs(spacingAtPlay - spacingFor(1.68))).toBeLessThan(1e-9)
  })
})

describe('goTo promise on supersession (problem 3)', () => {
  it('resolves within one frame when a new goTo lands mid-settle', async () => {
    const a = createAgent({ root: makeRig(), id: 's1', pos: [0, -3], yaw: 0 })
    let resolvedWith = 'never'
    a.goTo(0, 0, { yaw: Math.PI }).then(v => { resolvedWith = v })
    for (let i = 0; i < 60 * 12 && !a._settle; i++) a.update(DT)
    expect(a._settle).toBeTruthy()   // sanity: actually reached settle before superseding it

    a.goTo(2, 2, {})
    await Promise.resolve()
    expect(resolvedWith).toBeFalsy()   // superseded, not a real arrival — see #cancelMove
  })

  it('resolves within one frame when stop() lands mid-settle', async () => {
    const a = createAgent({ root: makeRig(), id: 's2', pos: [0, -3], yaw: 0 })
    let resolvedWith = 'never'
    a.goTo(0, 0, { yaw: Math.PI }).then(v => { resolvedWith = v })
    for (let i = 0; i < 60 * 12 && !a._settle; i++) a.update(DT)
    expect(a._settle).toBeTruthy()

    a.stop()
    await Promise.resolve()
    expect(resolvedWith).toBeFalsy()
  })

  it('sitAt bails instead of sitting down when its goTo is superseded', async () => {
    const a = createAgent({ root: makeRig(), id: 's3', pos: [0, -3], yaw: 0 })
    let sitAtResult = 'never'
    a.sitAt(0, 0, Math.PI).then(v => { sitAtResult = v })
    for (let i = 0; i < 60 * 12 && !a._settle; i++) a.update(DT)

    a.stop()
    await Promise.resolve()
    await Promise.resolve()   // sitAt's .then chain is one microtask deeper than goTo's
    expect(sitAtResult).toBeFalsy()
    expect(a.activity).not.toBe('sitting')
  })

  it('a fresh goTo landing mid-sitAt cancels it cleanly instead of sitting down under the new order', async () => {
    const a = createAgent({ root: makeRig(), id: 's5', pos: [0, -3], yaw: 0 })
    let sitAtResult = 'never'
    a.sitAt(0, 0, Math.PI).then(v => { sitAtResult = v })
    for (let i = 0; i < 60 * 12 && !a._settle; i++) a.update(DT)
    expect(a._settle).toBeTruthy()   // sanity: reached settle before the reroute

    a.goTo(2, 2, {})
    await Promise.resolve()
    await Promise.resolve()   // sitAt's .then is one microtask deeper than goTo's
    expect(sitAtResult).toBeFalsy()
    expect(a.activity).not.toBe('sitting')
    expect(a._move).toMatchObject({ x: 2, z: 2 })   // the new order actually took, not clobbered
  })

  // demo.js awaits its walks through Promise.all and then narrates the beat.
  // A superseded goTo has to show up in that array as a falsy entry, which is
  // what demo.js's arrived() looks for before it lets the script carry on.
  it('leaves a falsy entry in a Promise.all when one of the pair is superseded', async () => {
    const a = createAgent({ root: makeRig(), id: 's6', pos: [0, -3], yaw: 0 })
    const b = createAgent({ root: makeRig(), id: 's7', pos: [2, -3], yaw: 0 })
    const both = Promise.all([a.goTo(0, 0, {}), b.goTo(2, 0, {})])

    for (let i = 0; i < 60 * 12 && !a._settle; i++) { a.update(DT); b.update(DT) }
    expect(a._settle).toBeTruthy()   // sanity: a was really mid-arrival when the click landed
    a.goTo(-4, -4, {})               // a click sends `a` somewhere else mid-beat
    for (let i = 0; i < 60 * 20 && (b.moving || b._settle); i++) { a.update(DT); b.update(DT) }

    const got = await both
    expect(got.some(x => !x)).toBe(true)
    expect(got[1]).toBe(b)           // the other agent's walk was untouched
  })

  it('still resolves with the agent on an uninterrupted arrival', async () => {
    const a = createAgent({ root: makeRig(), id: 's4', pos: [0, -3], yaw: 0 })
    const p = a.goTo(0, 0, {})
    for (let i = 0; i < 60 * 20 && (a.moving || a._settle); i++) a.update(DT)
    const result = await p
    expect(result).toBe(a)
  })
})
