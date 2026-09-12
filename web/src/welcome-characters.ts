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
    const [THREE, { GLTFLoader }, { clone }, { getClip }] = await Promise.all([
      import('three'),
      import('three/addons/loaders/GLTFLoader.js'),
      import('three/addons/utils/SkeletonUtils.js'),
      import('./office/anim.js'),
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
    const gltf = await new GLTFLoader().loadAsync('/glb-lite/character.glb')
    const palette = [0xc29169, 0x779987, 0x7d8ca6]
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
      body.scale.setScalar((1.65 + index * 0.08) / bounds.getSize(new THREE.Vector3()).y)
      const root = new THREE.Group()
      root.add(body)
      const direction = index === 1 ? -1 : 1
      root.rotation.y = direction * Math.PI / 2
      scene.add(root)
      const mixer = new THREE.AnimationMixer(model)
      const action = mixer.clipAction(getClip('walk', index + 1))
      action.play()
      mixer.update(index * 0.23)
      return { root, mixer, direction, progress: [0.12, 0.55, 0.82][index], speed: 0.54 + index * 0.05 }
    })
    let width = 20
    const resize = () => {
      const rect = stage.getBoundingClientRect()
      if (!rect.width || !rect.height) return
      width = rect.width / rect.height * 2.19
      camera.left = -width / 2
      camera.right = width / 2
      camera.updateProjectionMatrix()
      renderer.setSize(rect.width, rect.height)
      render(0)
    }
    const render = (dt: number) => {
      for (const walker of walkers) {
        walker.progress = (walker.progress + walker.direction * walker.speed * dt / (width + 2) + 1) % 1
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
