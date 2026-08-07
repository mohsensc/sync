import * as THREE from 'three'
import { PALETTE, ZONES } from './zones-and-palette.js'
import type { CharacterState } from './characters.js'

/** Soft-clay look: matte materials, no gloss, soft ambient plus one warm key. */
export function buildScene(canvas: HTMLCanvasElement) {
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true })
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2))
  renderer.shadowMap.enabled = true
  renderer.shadowMap.type = THREE.PCFSoftShadowMap

  const scene = new THREE.Scene()
  scene.background = new THREE.Color(PALETTE.cream)

  const camera = new THREE.OrthographicCamera(-24, 24, 16, -16, 0.1, 200)
  camera.position.set(28, 26, 28)
  camera.lookAt(0, 0, 0)

  scene.add(new THREE.AmbientLight(0xffffff, 0.75))
  const key = new THREE.DirectionalLight(0xfff2dd, 1.1)
  key.position.set(18, 30, 12)
  key.castShadow = true
  scene.add(key)

  const floor = new THREE.Mesh(
    new THREE.BoxGeometry(44, 0.5, 34),
    new THREE.MeshLambertMaterial({ color: PALETTE.sand }),
  )
  floor.position.y = -0.25
  floor.receiveShadow = true
  scene.add(floor)

  // Placeholder zone markers. Real props are a separate asset project.
  for (const [name, box] of Object.entries(ZONES)) {
    const marker = new THREE.Mesh(
      new THREE.BoxGeometry(box.w, 0.6, box.d),
      new THREE.MeshLambertMaterial({ color: PALETTE.taupe }),
    )
    marker.position.set(box.x, 0.3, box.z)
    marker.name = `zone:${name}`
    marker.receiveShadow = true
    scene.add(marker)
  }

  const bodies = new Map<string, THREE.Mesh>()

  function render(chars: CharacterState[], emphasisOf: (agent: string) => number): void {
    const seen = new Set<string>()

    for (const c of chars) {
      seen.add(c.agent)
      let mesh = bodies.get(c.agent)
      if (!mesh) {
        mesh = new THREE.Mesh(
          new THREE.CapsuleGeometry(0.5, 0.9, 4, 12),
          new THREE.MeshLambertMaterial({ color: c.hair, transparent: true }),
        )
        mesh.castShadow = true
        bodies.set(c.agent, mesh)
        scene.add(mesh)
      }
      mesh.position.set(c.x, 1.1, c.z)
      ;(mesh.material as THREE.MeshLambertMaterial).opacity = emphasisOf(c.agent)
    }

    for (const [agent, mesh] of bodies) {
      if (seen.has(agent)) continue
      scene.remove(mesh)
      mesh.geometry.dispose()
      ;(mesh.material as THREE.Material).dispose()
      bodies.delete(agent)
    }

    renderer.render(scene, camera)
  }

  return { render }
}
