// The welcome page borrows the office's clay figures and walk cycle. Keep the
// renderer and asset out of the critical path for signing in.
const welcome = document.querySelector<HTMLElement>('#login-cta')!
const stage = document.querySelector<HTMLElement>('#welcome-characters')!
const pause = document.querySelector<HTMLButtonElement>('#welcome-characters-pause')!
const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)')
let paused = false
let started = false
let updatePlayback = () => {}

pause.addEventListener('click', () => {
  paused = !paused
  pause.textContent = paused ? 'Resume little walks' : 'Pause little walks'
  pause.setAttribute('aria-pressed', String(paused))
  updatePlayback()
})

async function start() {
  if (started || welcome.hidden || document.hidden || reducedMotion.matches) return
  started = true
  try {
    const [THREE, { GLTFLoader }, { clone }, { getClip }, argue, { spacingFor }, { createEncounters }, dressing] = await Promise.all([
      import('three'),
      import('three/addons/loaders/GLTFLoader.js'),
      import('three/addons/utils/SkeletonUtils.js'),
      import('./office/anim.js'),
      import('./office/clips/argue.js'),
      import('./office/highfive.js'),
      import('./welcome-encounters.js'),
      import('./office/dressing.js'),
    ])
    const renderer = new THREE.WebGLRenderer({ alpha: true, antialias: true })
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.5))
    renderer.setClearColor(0x000000, 0)
    renderer.domElement.setAttribute('aria-hidden', 'true')
    stage.append(renderer.domElement)
    const scene = new THREE.Scene()
    scene.add(new THREE.HemisphereLight(0xfff8ed, 0x998777, 2.8))
    const light = new THREE.DirectionalLight(0xfff6e5, 3)
    light.position.set(-3, 6, 8)
    scene.add(light)
    // A straight-on orthographic view keeps their feet on the screen edge.
    const camera = new THREE.OrthographicCamera(-10, 10, 2.15, -0.04, 0.1, 100)
    camera.position.set(0, 0, 10)
    // Reuse the office furniture, anchored to the floor and wholly behind
    // even the furthest character's depth lane.
    const bookcase = new THREE.Group()
    const coffeeCorner = new THREE.Group()
    bookcase.position.z = coffeeCorner.position.z = -24
    dressing.shelf(bookcase, 0, 0, 0.15, 1.15, 1.55)
    dressing.lounge(coffeeCorner, 0, 0)
    scene.add(bookcase, coffeeCorner)
    const gltf = await new GLTFLoader().loadAsync('/glb-lite/character.glb')
    const palette = [0xc29169, 0x779987, 0x7d8ca6, 0xa184a0, 0xb39b65]
    const walkers = palette.map((color, index) => {
      const model = clone(gltf.scene)
      model.traverse((node) => {
        if (!(node instanceof THREE.Mesh)) return
        const tint = (source: import('three').Material) => {
          const material = source.clone()
          if (material instanceof THREE.MeshStandardMaterial) {
            material.metalness = 0
            material.roughness = 0.9
            material.emissiveIntensity = material.emissiveMap ? 0.18 : 0
            material.color.set(color).lerp(new THREE.Color(0xffffff), 0.18)
          }
          return material
        }
        node.material = Array.isArray(node.material) ? node.material.map(tint) : tint(node.material)
      })
      model.updateMatrixWorld(true)
      const bounds = new THREE.Box3().setFromObject(model)
      const center = bounds.getCenter(new THREE.Vector3())
      model.position.set(-center.x, -bounds.min.y, -center.z)
      const body = new THREE.Group()
      body.add(model)
      // Matching heights keep the authored high-five palms at the same level.
      body.scale.setScalar(1.72 / bounds.getSize(new THREE.Vector3()).y)
      const root = new THREE.Group()
      root.add(body)
      // Keep entire animated figures in separate depth lanes. Sharing z=0
      // makes their limbs intersect when their screen positions cross.
      // Orthographic projection preserves their size and baseline in each lane.
      root.position.z = -index * 3
      const direction = index % 2 === 1 ? -1 : 1
      root.rotation.y = direction * Math.PI / 2
      scene.add(root)
      const mixer = new THREE.AnimationMixer(model)
      const actions = {
        walk: mixer.clipAction(getClip('walk', index + 1)),
        wave: mixer.clipAction(getClip('wave', index + 1)),
        idle: mixer.clipAction(getClip('idle', index + 1)),
        highfive: mixer.clipAction(getClip('highfive', index + 1)).setLoop(THREE.LoopOnce, 1),
        argue: mixer.clipAction(argue.getClip('argue')),
        argueReact: mixer.clipAction(argue.getClip('argueReact')),
      }
      actions.highfive.clampWhenFinished = true
      actions.walk.play()
      mixer.update(index * 0.23)
      return {
        root, body, mixer, actions, action: actions.walk, direction,
        progress: [0.08, 0.28, 0.5, 0.72, 0.91][index], speed: 0.54 + index * 0.04,
        pace: 0, remaining: 2 + index * 3, elapsed: 0, beat: index,
        activity: 'walk' as 'walk' | 'wave' | 'look',
      }
    })
    const encounters = createEncounters(walkers, spacingFor(1.72))
    let width = 20
    const resize = () => {
      const rect = stage.getBoundingClientRect()
      if (!rect.width || !rect.height) return
      width = rect.width / rect.height * 2.19
      bookcase.position.x = -width * 0.28
      coffeeCorner.position.x = width * 0.28
      camera.left = -width / 2
      camera.right = width / 2
      camera.updateProjectionMatrix()
      renderer.setSize(rect.width, rect.height)
      render(0)
    }
    const render = (dt: number) => {
      const paired = encounters(dt, width)
      for (const walker of walkers) {
        if (paired.has(walker)) continue
        walker.remaining -= dt
        walker.elapsed += dt
        if (walker.remaining <= 0) {
          if (walker.activity === 'walk') {
            walker.activity = (['wave', 'look'] as const)[walker.beat % 2]
            walker.beat++
            walker.remaining = walker.activity === 'wave' ? 4.4 : 3.8
          } else {
            walker.activity = 'walk'
            if (walker.beat % 2 === 0) walker.direction *= -1
            walker.remaining = 8 + Math.random() * 8
          }
          walker.elapsed = 0
          const next = walker.actions[walker.activity === 'walk' ? 'walk' : walker.activity === 'wave' ? 'wave' : 'idle']
          if (next !== walker.action) {
            next.reset().setEffectiveWeight(1).play()
            walker.action.crossFadeTo(next, 0.35, false)
            walker.action = next
          }
        }
        // Turn toward the visitor for a hello or a curious look around.
        const heading = walker.activity === 'walk' ? walker.direction * Math.PI / 2
          : walker.activity === 'look' ? Math.sin(walker.elapsed * 1.8) * 0.65 : 0
        walker.root.rotation.y += (heading - walker.root.rotation.y) * Math.min(1, dt * 5)
        const targetPace = walker.activity === 'walk' && Math.abs(heading - walker.root.rotation.y) < 0.3 ? 1 : 0
        walker.pace += (targetPace - walker.pace) * Math.min(1, dt * 6)
        walker.progress = (walker.progress + walker.direction * walker.speed * walker.pace * dt / (width + 2) + 1) % 1
        walker.root.position.x = walker.progress * (width + 2) - (width + 2) / 2
        walker.mixer.update(dt)
      }
      renderer.render(scene, camera)
    }
    let frame = 0
    let previous = 0
    const tick = (now: number) => {
      // 30 fps is ample for a tiny decorative scene.
      if (now - previous >= 1000 / 30) {
        render(previous ? Math.min((now - previous) / 1000, 0.08) : 0)
        previous = now
      }
      frame = requestAnimationFrame(tick)
    }
    updatePlayback = () => {
      cancelAnimationFrame(frame)
      frame = 0
      previous = 0
      const visible = !welcome.hidden && !reducedMotion.matches
      stage.hidden = !visible
      pause.hidden = !visible
      if (visible && !document.hidden && !paused) frame = requestAnimationFrame(tick)
    }
    new ResizeObserver(resize).observe(stage)
    stage.hidden = false
    resize()
    updatePlayback()
    renderer.domElement.addEventListener('webglcontextlost', (event) => {
      event.preventDefault()
      paused = true
      updatePlayback()
      stage.hidden = true
      pause.hidden = true
    })
  } catch {
    // Decoration is optional on devices without WebGL or if the model fails.
    stage.hidden = true
    pause.hidden = true
  }
}

const sync = () => { updatePlayback(); void start() }
new MutationObserver(sync).observe(welcome, { attributes: true, attributeFilter: ['hidden'] })
document.addEventListener('visibilitychange', sync)
reducedMotion.addEventListener('change', sync)
// Let the primary interface paint before requesting the office assets.
window.setTimeout(sync, 600)
