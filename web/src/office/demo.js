// The scripted demo. ~42 seconds, five beats, replayable.
//
// It is a story about co-ordination, not about walking:
//   0-10s  two agents read the same file and share a desk. Rung 0, no drama.
//  10-17s  a third goes to the vault because it touched auth.
//  17-27s  two agents want the same symbol. The second one is blocked. Rung 3.
//  27-34s  they split the work and one walks away.
//  34-42s  a long job starts and the tortoise carries it across the floor.
//
// runDemo() is injected with everything it touches so it never reaches into
// office.html's module scope. Call the returned .cancel() to stop it dead.

import * as THREE from 'three'
import * as Z from './zones.js'

const wait = (ms, tok) => new Promise((res, rej) => {
  const t = setTimeout(() => (tok.dead ? rej(CANCEL) : res()), ms)
  tok.timers.push(t)
})
const CANCEL = Symbol('demo-cancelled')

/** Race a promise against cancellation so goTo() can't outlive a restart. */
const race = (p, tok) => Promise.race([p, new Promise((_, rej) => tok.rejects.push(rej))])

/** World.highfive returns an encounter record, not a promise. Wait it out. */
function waitForEncounter(e) {
  if (!e) return Promise.resolve()
  return new Promise(res => {
    const poll = () => (e.phase === 'done' ? res() : requestAnimationFrame(poll))
    poll()
  })
}

// Region blame needs an actual line range in an actual file, or the whole
// seed idea ("the lines an agent actually holds", not just the file) never
// shows up outside a live relay session. office.html assigns each cast
// member's `.gitPath` (see AGENT_CAST there); this is the same idea one
// level down — a start/end pair well inside that same file, verified by
// hand against `wc -l` while writing this so a stray line or two of drift
// doesn't push a range past EOF. Not every cast member gets one: a1's file
// (python/src/agent_presence/__init__.py) is an empty stub with zero lines,
// which makes it the natural exercise of the "no usable range" fallback
// path rather than a range I'd have to fake, and a5 (README.md) is left
// whole-file on purpose so there's always at least one demo agent to A/B
// the region view against the ownership-bar view.
//   a2 cpp/hook/hook.cpp   (813 lines) -> 120-150, deep in the message pack loop
//   a3 web/src/office/anim.js (1094 lines) -> 200-230, forearm-roll IK math
//   a4 go/cmd/gorelay/main.go (100 lines) -> 15-40, import block + wiring
// If this repo's history ever reshuffles these files enough to push a range
// past EOF, blamecard.js's fallback (see gitapi.mjs's own bogus-range
// handling) just shows the whole-file view instead — never an empty box.
const REGIONS = {
  a2: { start: 120, end: 150 },
  a3: { start: 200, end: 230 },
  a4: { start: 15, end: 40 },
}

export function runDemo(ctx) {
  const { agents, world, tortoise, scene, caption, focus, zoneUI, onBeat } = ctx
  const tok = { dead: false, timers: [], rejects: [] }

  // Cast. Named for what they do in the story, not for anything real.
  const [a1, a2, a3, a4, a5] = agents

  // Stamp regions onto whichever agent objects actually carry each id —
  // office.html builds AGENT_CAST and assigns `.gitPath` before runDemo()
  // is ever called, so this only ever adds the two extra fields, never
  // touches gitPath itself.
  for (const a of agents) {
    const r = REGIONS[a.id]
    a.gitStart = r ? r.start : undefined
    a.gitEnd = r ? r.end : undefined
  }

  // --- the contested-symbol marker ---------------------------------------
  const lock = new THREE.Group()
  const lockRing = new THREE.Mesh(
    new THREE.RingGeometry(0.66, 0.94, 44),
    new THREE.MeshBasicMaterial({ color: 0xD9714F, transparent: true, opacity: 0.9, depthWrite: false, side: THREE.DoubleSide })
  )
  lockRing.rotation.x = -Math.PI / 2
  lockRing.position.y = 0.07
  lock.add(lockRing)
  const lockSprite = new THREE.Sprite(new THREE.SpriteMaterial({
    map: symbolTexture('Order.total', 'contested'), transparent: true, depthTest: false,
  }))
  lockSprite.scale.set(3.0, 0.75, 1)
  // Above the agents' own badges (y = 2.2). At 2.15 it was drawn behind them
  // and the contested symbol never showed up on screen at all.
  lockSprite.position.y = 3.05
  lock.add(lockSprite)
  lock.visible = false
  scene.add(lock)

  let pulseT = 0
  const pulse = (dt) => {
    if (!lock.visible) return
    pulseT += dt
    const k = 0.5 + 0.5 * Math.sin(pulseT * 5)
    lockRing.material.opacity = 0.45 + 0.5 * k
    lockRing.scale.setScalar(1 + 0.1 * k)
  }

  // --- tortoise plod ------------------------------------------------------
  let plod = null
  const stepTortoise = (dt) => {
    if (!plod) return
    plod.t += dt / plod.dur
    const u = Math.min(1, plod.t)
    tortoise.position.x = plod.from[0] + (plod.to[0] - plod.from[0]) * u
    tortoise.position.z = plod.from[1] + (plod.to[1] - plod.from[1]) * u
    // A slow waddle, so it reads as walking rather than sliding.
    tortoise.position.y = Math.abs(Math.sin(u * 26)) * 0.035
    tortoise.rotation.z = Math.sin(u * 26) * 0.045
    if (u >= 1) plod = null
  }

  const update = (dt) => { pulse(dt); stepTortoise(dt) }

  async function script() {
    const say = (t) => { caption(t); if (onBeat) onBeat(t) }

    // reset -------------------------------------------------------------
    Z.resetSlots()
    lock.visible = false
    plod = null
    tortoise.position.set(2.0, 0, 4.3)
    tortoise.rotation.set(0, -0.9, 0)
    agents.forEach(a => { a.stop(); a.say(''); a.setState('ok'); a.busy = false; a.act('idle') })
    zoneUI.highlight(null)

    // Park everyone off to the side so the beats start from a clean floor.
    // There is no pathfinding, so the start points are chosen such that every
    // walk in the script is a straight line that misses the furniture. Pulled
    // in with the room: the old -8.6 / 8.2 marks are now inside the shelving
    // on the left and the crate stacks on the right.
    const park = [[-7.7, -3.4], [-7.7, -2.2], [-7.7, -1.0], [7.5, -0.4], [7.5, 1.4]]
    agents.forEach((a, i) => { a.pos.x = park[i][0]; a.pos.z = park[i][1]; a.yaw = Math.PI / 2 })
    focus([0.4, -0.5], 1.0, 0.75)
    await wait(700, tok)

    // ---------------------------------------------------------------- 1
    // Rung 0: two agents, same file, same desk. Nothing interrupts.
    say('Two agents open the same file. They share a desk and get on with it.')
    zoneUI.highlight('desks')
    focus([-3.2, -1.0], 0.86, 0.72)

    const deskZone = Z.zoneFor('read', 'src/orders/total.ts')   // -> desks
    const s1 = Z.claimSlot(deskZone, a1.id)
    const s2 = Z.claimSlot(deskZone, a2.id, { share: a1.id })   // co-locate

    a1.say('read src/orders/total.ts', 'ok')
    a2.say('read src/orders/total.ts', 'ok')
    await race(Promise.all([
      a1.goTo(s1.pos[0] - 0.34, s1.pos[1], { yaw: s1.yaw, label: 'desk 1' }),
      a2.goTo(s2.pos[0] + 0.10, s2.pos[1] + 0.28, { yaw: s2.yaw, label: 'desk 1' }),
    ]), tok)
    a1.act('reading'); a2.act('reading')
    await wait(3600, tok)

    // ---------------------------------------------------------------- 2
    say('A third agent touches auth, so it goes to the vault. That work is alone by design.')
    const vault = Z.zoneFor('edit', 'src/auth/token.ts')        // -> vault
    zoneUI.highlight(vault)
    focus([-6.4, -5.0], 0.82, 0.55)
    const sv = Z.claimSlot(vault, a3.id)
    a3.say('edit src/auth/token.ts', 'working')
    a3.setState('working')
    await race(a3.goTo(sv.pos[0], sv.pos[1] + 0.5, { yaw: sv.yaw, label: 'vault' }), tok)
    a3.act('reading')
    await wait(2600, tok)

    // ---------------------------------------------------------------- 3
    // Rung 3: same symbol. The second one gets blocked.
    say('Two more head for the same symbol, on the same desk.')
    zoneUI.highlight('desks')
    focus([4.0, -0.9], 0.7, 0.88)

    // Desk 3. a4 takes the seat; a5 has to stop short of it.
    const seat = Z.ZONES.desks.slots[2]        // [4.0, -1.35, PI]
    const p4 = [seat[0], seat[1]]
    const p5 = [seat[0] + 0.05, seat[1] + 1.15]
    lock.position.set(seat[0] + 0.03, 0, seat[1] + 0.575)

    a4.say('edit Order.total', 'working'); a4.setState('working')
    a5.say('edit Order.total', 'working'); a5.setState('working')

    // a4 goes straight to the seat. a5 sets off a beat later and runs into it.
    const arrive4 = race(a4.goTo(p4[0], p4[1], { yaw: seat[2], label: 'desk 3' }), tok)
    await wait(900, tok)
    const arrive5 = race(a5.goTo(p5[0], p5[1], { yaw: Math.PI, label: 'desk 3' }), tok)
    await race(Promise.all([arrive4, arrive5]), tok)

    // They stop and turn to face each other. That is the whole tell.
    say('Both want Order.total. The first one holds it; the second is blocked.')
    lock.visible = true
    a4.say('holds Order.total', 'done')
    a5.say('blocked on Order.total', 'blocked')
    a5.setState('blocked')
    await race(Promise.all([
      a4.faceTowards(p5[0], p5[1]),
      a5.faceTowards(p4[0], p4[1]),
    ]), tok)
    a5.act('idle')
    a4.act('idle')
    await wait(4000, tok)

    // ---------------------------------------------------------------- 4
    say('They split it. One keeps the symbol, the other takes the caller and moves.')
    a5.setState('ok')
    a4.setState('ok')
    a5.say('takes the call sites', 'ok')
    a4.say('keeps Order.total', 'ok')
    lock.visible = false
    // agent.js's World walks them onto highfive.js's marks and fires the
    // same clip on both, same frame, so the palms actually meet.
    await race(waitForEncounter(world.highfive(a4, a5)), tok)
    a4.act('reading')

    const s5 = Z.claimSlot('desks', a5.id)
    await race(a5.goTo(s5.pos[0], s5.pos[1], { yaw: s5.yaw, label: 'another desk' }), tok)
    a5.act('reading')
    await wait(1500, tok)

    // ---------------------------------------------------------------- 5
    say('A long job starts. The tortoise carries it across the floor until it finishes.')
    zoneUI.highlight(null)
    focus([4.4, 5.4], 0.72, 0.66)
    // Clear the earlier beats' badges. Five pills stacked on top of each other
    // is noise, and this beat is about one thing.
    agents.forEach(a => a.say(''))
    a1.say('waiting on migration', 'idle')
    a2.say('waiting on migration', 'idle')
    // Along the open +z edge, in front of the hammock. At z = 5.0 it walked
    // straight through the hammock posts.
    tortoise.rotation.y = Math.PI / 2
    plod = { from: [1.4, 6.15], to: [6.9, 6.15], dur: 8.2, t: 0 }
    tortoise.position.set(1.4, 0, 6.15)
    await wait(8600, tok)

    say('That is the whole loop: co-locate when it is safe, block when it is not, then resolve.')
    zoneUI.highlight(null)
    focus([0.4, -0.5], 1.0, 0.75)
    agents.forEach(a => a.say(''))
    await wait(2500, tok)
    caption('')
    return 'done'
  }

  const promise = script().catch(e => { if (e !== CANCEL) throw e; return 'cancelled' })

  return {
    update,
    promise,
    cancel() {
      tok.dead = true
      tok.timers.forEach(clearTimeout)
      tok.rejects.forEach(r => r(CANCEL))
      agents.forEach(a => a.stop())
      lock.visible = false
      plod = null
      scene.remove(lock)
    },
  }
}

function symbolTexture(text, sub) {
  const c = document.createElement('canvas')
  c.width = 512; c.height = 128
  const g = c.getContext('2d')
  g.fillStyle = 'rgba(255,253,250,0.97)'
  roundRect(g, 26, 14, 460, 100, 22)
  g.fill()
  g.lineWidth = 5; g.strokeStyle = '#D9714F'; g.stroke()
  g.textAlign = 'center'
  g.fillStyle = '#35455C'
  g.font = '600 42px ui-monospace, SFMono-Regular, Menlo, monospace'
  g.fillText(text, 256, 58)
  g.fillStyle = '#D9714F'
  g.font = '500 28px ui-sans-serif, -apple-system, Segoe UI, sans-serif'
  g.fillText(sub, 256, 95)
  const t = new THREE.CanvasTexture(c)
  t.anisotropy = 4
  return t
}

function roundRect(g, x, y, w, h, r) {
  g.beginPath()
  g.moveTo(x + r, y); g.lineTo(x + w - r, y)
  g.quadraticCurveTo(x + w, y, x + w, y + r); g.lineTo(x + w, y + h - r)
  g.quadraticCurveTo(x + w, y + h, x + w - r, y + h); g.lineTo(x + r, y + h)
  g.quadraticCurveTo(x, y + h, x, y + h - r); g.lineTo(x, y + r)
  g.quadraticCurveTo(x, y, x + r, y)
  g.closePath()
}
