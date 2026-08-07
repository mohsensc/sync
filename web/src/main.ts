import { CharacterRegistry } from './characters.js'
import { buildScene } from './scene.js'
import { Subscription } from './subscribe.js'

const canvas = document.getElementById('world') as HTMLCanvasElement
const registry = new CharacterRegistry()
const me = new URLSearchParams(location.search).get('human') ?? ''
const sub = new Subscription(registry, me)
const scene = buildScene(canvas)

const room = new URLSearchParams(location.search).get('room') ?? ''
const ws = new WebSocket(`ws://127.0.0.1:8799`)
ws.onopen = () => ws.send(JSON.stringify({ type: 'join', room, agent: 'viewer', human: me }))
ws.onmessage = (e) => {
  try {
    sub.onMessage(JSON.parse(e.data), Date.now())
  } catch {
    // A bad frame must never blank the world.
  }
}

let last = performance.now()
function frame(t: number) {
  const dt = Math.min((t - last) / 1000, 0.1)
  last = t
  registry.expire(Date.now())
  registry.step(dt)
  scene.render(registry.all(), (a) => sub.emphasis(a))
  requestAnimationFrame(frame)
}
requestAnimationFrame(frame)
