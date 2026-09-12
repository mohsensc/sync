import { inject } from '@vercel/analytics'
import { CharacterRegistry } from './characters.js'
import { buildScene } from './scene.js'
import { Subscription } from './subscribe.js'
import { connectWithFrames } from './relay.js'

// Initialize Vercel Web Analytics
inject()

const canvas = document.getElementById('world') as HTMLCanvasElement
const registry = new CharacterRegistry()
const me = new URLSearchParams(location.search).get('human') ?? ''
const sub = new Subscription(registry)
const scene = buildScene(canvas)

const room = new URLSearchParams(location.search).get('room') ?? ''
connectWithFrames({
  url: 'ws://127.0.0.1:8799',
  room,
  human: me,
  onFrame: (msg) => sub.onMessage(msg, Date.now()),
})

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
