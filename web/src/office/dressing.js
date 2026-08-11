// Set dressing for the office.
//
// Everything here is a primitive. No new assets — the brief forbids generating
// any, and the props that exist already carry the identity of each zone. This
// file only adds the context that makes them read: chairs so the seated figures
// aren't floating, monitors so a desk reads as a desk and not a bench, and
// enough furniture along the walls that the room stops looking evacuated.
//
// Nothing in here is pickable. attachInteraction() builds its own proxy list, so
// these meshes never swallow a click meant for the floor.
//
// Orientation convention: everything takes the EXTERNAL yaw (the one zones.js
// and agent.js use, forward = -(sin y, cos y)). A chair built with its back at
// local +z and a monitor built with its screen at local +z both end up facing
// the right way with rotation.y = seatYaw. Worked through in the comments below
// rather than fudged, because getting it wrong points every screen at the wall.

import * as THREE from 'three'

export const P = {
  cream: 0xF0ECE6, sand: 0xE9E0CE, taupe: 0xC3B39B, sage: 0xE5E1D2,
  butter: 0xF7DFAF, mustard: 0xD6B45C, caramel: 0xC0762A, coffee: 0xB0674F,
  terracotta: 0xD9714F, salmon: 0xE8946C, rose: 0xD8BDB6, mauve: 0xA5738C,
  slate: 0x8A94A3, navy: 0x35455C, plum: 0x4A1F3D,
}

// Shared materials. The dressing is ~120 meshes; giving each its own material
// would triple the draw calls for no visible gain.
const M = {}
function mat(name, color, extra = {}) {
  if (!M[name]) M[name] = new THREE.MeshStandardMaterial({ color, roughness: 0.9, metalness: 0, ...extra })
  return M[name]
}

// Shared geometry, reused and rescaled per instance.
const BOX = new THREE.BoxGeometry(1, 1, 1)
const CYL = new THREE.CylinderGeometry(0.5, 0.5, 1, 12)
const SPH = new THREE.SphereGeometry(0.5, 14, 10)

/** One box. Sizes and positions in metres, so the call sites read as furniture. */
function box(out, m, w, h, d, x, y, z, ry = 0) {
  const o = new THREE.Mesh(BOX, m)
  o.scale.set(w, h, d); o.position.set(x, y, z); o.rotation.y = ry
  o.castShadow = true; o.receiveShadow = true
  out.push(o); return o
}
function cyl(out, m, r, h, x, y, z) {
  const o = new THREE.Mesh(CYL, m)
  o.scale.set(r * 2, h, r * 2); o.position.set(x, y, z)
  o.castShadow = true; o.receiveShadow = true
  out.push(o); return o
}
function sph(out, m, r, x, y, z) {
  const o = new THREE.Mesh(SPH, m)
  o.scale.setScalar(r * 2); o.position.set(x, y, z)
  o.castShadow = true; o.receiveShadow = true
  out.push(o); return o
}

/**
 * A chair at a desk seat.
 *
 * The seated clip drops the pelvis to y = 0.433 and walks it 0.22 m back, so
 * the seat pad sits at 0.42 and the whole chair is nudged back along the
 * person's spine. Without this the figures sit on thin air, which was the
 * single most obviously broken thing in the build.
 */
export function chair(group, x, z, yaw, color = P.taupe) {
  const out = []
  const g = new THREE.Group()
  g.userData.meshes = out          // callers that only want the mesh list
  const seatM = mat('chairSeat', color)
  const legM = mat('chairLeg', P.coffee)
  // back at local +z, so rotation.y = yaw puts it behind the sitter
  //
  // Pad top is 0.38. The seated clip puts the Hips joint at 0.433 and the butt
  // surface roughly 8 cm under that, so a 0.46 pad — the obvious "chair height"
  // — actually cut up through the figure's thighs. Measured, then lowered.
  box(out, seatM, 0.46, 0.08, 0.46, 0, 0.34, 0)
  box(out, seatM, 0.46, 0.44, 0.08, 0, 0.60, 0.19)
  for (const [lx, lz] of [[-0.18, -0.18], [0.18, -0.18], [-0.18, 0.18], [0.18, 0.18]])
    cyl(out, legM, 0.028, 0.34, lx, 0.17, lz)
  out.forEach(o => g.add(o))
  g.position.set(x, 0, z)
  g.rotation.y = yaw
  group.add(g)
  return g
}

/**
 * A monitor on a desk, screen facing the sitter.
 *
 * This is the piece that stops a desk reading as a bench. The desk mesh really
 * is just a slab on four stubby legs; no amount of rescaling makes it a
 * workstation, but a screen on top does it immediately.
 */
export function monitor(group, x, z, yaw, deskTop, tint = P.slate) {
  const out = []
  const g = new THREE.Group()
  const shell = mat('monShell', P.cream)
  const screen = mat('monScreen_' + tint.toString(16), tint, { roughness: 0.55, emissive: tint, emissiveIntensity: 0.16 })
  box(out, mat('monFoot', P.taupe), 0.26, 0.025, 0.16, 0, deskTop + 0.012, 0)
  cyl(out, mat('monNeck', P.taupe), 0.028, 0.17, 0, deskTop + 0.10, 0)
  // Panel tilted back a touch. Screen face is local +z.
  const panel = box(out, shell, 0.56, 0.36, 0.035, 0, deskTop + 0.36, 0.01)
  panel.rotation.x = -0.08
  const face = new THREE.Mesh(BOX, screen)
  face.scale.set(0.50, 0.30, 0.012)
  face.position.set(0, deskTop + 0.36, 0.032)
  face.rotation.x = -0.08
  face.castShadow = false; face.receiveShadow = false
  out.push(face)
  // keyboard
  box(out, mat('kbd', P.sand), 0.42, 0.022, 0.15, 0, deskTop + 0.011, -0.30)
  out.forEach(o => g.add(o))
  g.position.set(x, 0, z)
  g.rotation.y = yaw
  group.add(g)
  return out
}

/** Potted plant. Three spheres and a pot; reads fine at this distance. */
export function plant(group, x, z, s = 1) {
  const out = []
  const g = new THREE.Group()
  cyl(out, mat('pot', P.caramel), 0.22 * s, 0.30 * s, 0, 0.15 * s, 0)
  cyl(out, mat('soil', P.plum), 0.19 * s, 0.04 * s, 0, 0.30 * s, 0)
  sph(out, mat('leafA', P.sage), 0.30 * s, 0, 0.60 * s, 0)
  sph(out, mat('leafB', 0xB9C7A8), 0.22 * s, 0.20 * s, 0.82 * s, 0.06 * s)
  sph(out, mat('leafA', P.sage), 0.19 * s, -0.18 * s, 0.80 * s, -0.08 * s)
  out.forEach(o => g.add(o))
  g.position.set(x, 0, z)
  group.add(g)
  return out
}

/** Open shelving. Fills a wall and gives the room a sense of storage. */
export function shelf(group, x, z, yaw, w = 1.6, h = 1.9) {
  const out = []
  const g = new THREE.Group()
  const body = mat('shelfBody', P.coffee)
  const t = 0.06
  box(out, body, t, h, 0.42, -w / 2, h / 2, 0)
  box(out, body, t, h, 0.42, w / 2, h / 2, 0)
  const levels = 4
  for (let i = 0; i <= levels; i++) {
    const y = (h / levels) * i
    box(out, body, w, t, 0.42, 0, Math.min(y, h - t / 2), 0)
  }
  // Contents: a few boxes and binders in the palette, deterministic so the
  // scene looks the same every reload.
  const cols = [P.mustard, P.terracotta, P.slate, P.butter, P.mauve, P.salmon]
  let k = 0
  for (let i = 0; i < levels; i++) {
    const y = (h / levels) * i + t / 2
    let cx = -w / 2 + 0.14
    while (cx < w / 2 - 0.16) {
      const bw = 0.09 + ((k * 37) % 5) * 0.03
      const bh = 0.20 + ((k * 53) % 4) * 0.045
      box(out, mat('bin' + (k % cols.length), cols[k % cols.length]), bw, bh, 0.28, cx + bw / 2, y + bh / 2, 0)
      cx += bw + 0.015
      k++
    }
  }
  out.forEach(o => g.add(o))
  g.position.set(x, 0, z)
  g.rotation.y = yaw
  group.add(g)
  return out
}

/** Low cabinet / console. Used under the phone wall and by reception. */
export function console_(group, x, z, yaw, w = 1.8, h = 0.72) {
  const out = []
  const g = new THREE.Group()
  const body = mat('cabBody', P.taupe)
  box(out, body, w, h, 0.46, 0, h / 2, 0)
  box(out, mat('cabTop', P.sand), w + 0.08, 0.05, 0.52, 0, h + 0.02, 0)
  const n = Math.max(2, Math.round(w / 0.6))
  for (let i = 0; i < n; i++) {
    const dx = -w / 2 + w * (i + 0.5) / n
    box(out, mat('cabDrawer', P.cream), w / n - 0.06, h * 0.38, 0.02, dx, h * 0.68, 0.235)
    box(out, mat('cabPull', P.coffee), w / n - 0.26, 0.03, 0.03, dx, h * 0.68, 0.25)
  }
  out.forEach(o => g.add(o))
  g.position.set(x, 0, z)
  g.rotation.y = yaw
  group.add(g)
  return out
}

/** A stack of paper trays — small, cheap, reads as "work happens here". */
export function trays(group, x, y, z, yaw, n = 3) {
  const out = []
  const g = new THREE.Group()
  const cols = [P.butter, P.salmon, P.sage]
  for (let i = 0; i < n; i++) {
    box(out, mat('tray' + i, cols[i % cols.length]), 0.30, 0.035, 0.22, 0, y + i * 0.075, 0)
    box(out, mat('paper', 0xFFFDFA), 0.26, 0.028, 0.19, 0, y + i * 0.075 + 0.03, 0)
  }
  out.forEach(o => g.add(o))
  g.position.set(x, 0, z)
  g.rotation.y = yaw
  group.add(g)
  return out
}

/**
 * Context for the phone wall.
 *
 * The prop hangs on the back wall with nothing around it, which reads as a
 * mistake rather than a fixture. It gets a console underneath, a chair turned
 * toward it, a pinboard of call notes beside it, a rug to bound the area and a
 * plant, so the corner reads as a place someone goes to make a call.
 */
export function phoneNook(group, x, z, wallZ) {
  // Two lists on purpose. `out` holds loose meshes built in this function's own
  // local space, which get parented to g at the end. `tracked` holds meshes the
  // sub-builders have ALREADY parented into their own positioned subgroups —
  // re-adding those to g would strip the subgroup transform and dump the
  // console and the chair at the room origin. That is exactly what happened the
  // first time round.
  const out = []
  const tracked = []
  const g = new THREE.Group()

  // Console directly under the wall unit, back to the wall (faces +z).
  console_(g, x, wallZ + 0.30, 0, 1.7, 0.70).forEach(o => tracked.push(o))

  // A notebook and a mug-sized block on it, so the top isn't bare.
  box(out, mat('pad', 0xFFFDFA), 0.26, 0.02, 0.19, x - 0.5, 0.76, wallZ + 0.30)
  box(out, mat('padLine', P.mauve), 0.26, 0.006, 0.04, x - 0.5, 0.772, wallZ + 0.24)

  // Pinboard beside the phone wall, with note cards.
  const bx = x + 1.85
  box(out, mat('boardFrame', P.coffee), 1.30, 0.95, 0.06, bx, 1.85, wallZ + 0.06)
  box(out, mat('boardFace', 0xE0CFAF), 1.18, 0.83, 0.02, bx, 1.85, wallZ + 0.10)
  const noteCols = [P.butter, P.salmon, P.sage, P.rose, P.mustard]
  let i = 0
  for (const [nx, ny] of [[-0.36, 0.22], [0.02, 0.26], [0.38, 0.18], [-0.30, -0.16], [0.10, -0.22], [0.42, -0.14]]) {
    box(out, mat('note' + (i % noteCols.length), noteCols[i % noteCols.length]),
      0.22, 0.20, 0.012, bx + nx, 1.85 + ny, wallZ + 0.115)
    i++
  }

  // Cable runs from the wall unit down to the console. Sells it as wired.
  for (const [dx, len, tilt] of [[-0.30, 0.62, 0.10], [0.10, 0.55, -0.07], [0.34, 0.68, 0.14]]) {
    const c = cyl(out, mat('cable', P.navy), 0.022, len, x + dx, 1.10 - len / 2 + 0.30, wallZ + 0.22)
    c.rotation.z = tilt
  }

  // A chair pushed off to one side rather than centred on the console. Dead
  // centre put it on top of the phone zone's first standing slot, so anyone
  // sent to make a call stood inside it.
  chair(g, x - 1.55, wallZ + 1.05, 0.5, P.slate).userData.meshes.forEach(o => tracked.push(o))
  plant(g, x + 3.0, wallZ + 0.55, 0.95).forEach(o => tracked.push(o))

  // A rug that bounds the nook so it reads as one place, not scattered props.
  const rug = new THREE.Mesh(new THREE.CircleGeometry(1.85, 40),
    new THREE.MeshStandardMaterial({ color: P.mauve, roughness: 1, metalness: 0,
      transparent: true, opacity: 0.5 }))
  rug.rotation.x = -Math.PI / 2
  rug.position.set(x + 0.1, 0.012, wallZ + 1.25)
  rug.receiveShadow = true
  g.add(rug)

  out.forEach(o => g.add(o))
  group.add(g)
  return out.concat(tracked)
}

/**
 * Low table and stools. Goes on the lounge rug, which was the last big patch
 * of bare floor once the desks and walls were dressed.
 */
export function lounge(group, x, z) {
  const out = []
  const g = new THREE.Group()
  const topM = mat('loungeTop', P.coffee)
  const legM = mat('loungeLeg', P.taupe)
  box(out, topM, 1.15, 0.07, 0.70, 0, 0.40, 0)
  for (const [lx, lz] of [[-0.48, -0.26], [0.48, -0.26], [-0.48, 0.26], [0.48, 0.26]])
    cyl(out, legM, 0.035, 0.40, lx, 0.20, lz)
  // A couple of books and a mug so the top isn't an empty slab.
  box(out, mat('bookA', P.terracotta), 0.26, 0.05, 0.19, -0.24, 0.46, 0.04)
  box(out, mat('bookB', P.butter), 0.24, 0.045, 0.18, -0.22, 0.51, -0.01)
  cyl(out, mat('loungeMug', P.cream), 0.05, 0.10, 0.30, 0.49, 0.06)
  // Stools either side.
  for (const [sx2, sz2] of [[-1.05, 0.30], [1.05, -0.30]]) {
    cyl(out, mat('stoolTop', P.mustard), 0.24, 0.10, sx2, 0.43, sz2)
    for (const [ox, oz] of [[-0.13, -0.13], [0.13, -0.13], [-0.13, 0.13], [0.13, 0.13]])
      cyl(out, legM, 0.028, 0.38, sx2 + ox, 0.19, sz2 + oz)
  }
  out.forEach(o => g.add(o))
  g.position.set(x, 0, z)
  g.rotation.y = 0.35
  group.add(g)
  return out
}

/** Framed panels on the back wall, so it isn't a blank slab. */
export function wallArt(group, xs, wallZ) {
  const out = []
  const g = new THREE.Group()
  const cols = [P.terracotta, P.slate, P.mustard]
  xs.forEach((x, i) => {
    box(out, mat('frame', P.coffee), 0.86, 1.06, 0.05, x, 2.30, wallZ + 0.05)
    box(out, mat('art' + i, cols[i % cols.length]), 0.74, 0.94, 0.02, x, 2.30, wallZ + 0.09)
  })
  out.forEach(o => g.add(o))
  group.add(g)
  return out
}

/**
 * Build everything. Called once the GLB loads have settled, because the desk
 * dressing needs the real seat positions.
 *
 * @returns {{ group: THREE.Group, meshes: THREE.Mesh[] }} meshes is returned so
 *   office.html can fold them into its wireframe toggle.
 */
export function buildDressing({ desks = [], occupied = [], wallZ = -6.63, wallX = -8.83, deskTop = 0.76 } = {}) {
  const group = new THREE.Group()
  group.name = 'dressing'
  const meshes = []
  const add = arr => arr.forEach(o => meshes.push(o))

  // --- desks become workstations ------------------------------------------
  //
  // Every desk chair has two marks: PULLED OUT, under where the sit clip puts
  // the pelvis, and TUCKED, pushed under the desk top.
  //
  // It has to be both, because a desk's standing mark and its sitting position
  // are nearly the same point — an agent walks to the slot and then sits
  // roughly in place. Park the chair at the sitting position and it swallows
  // anyone standing there; park it tucked and anyone who sits floats in mid
  // air with the backrest through their spine. So the chair moves: office.html
  // slides it between the two marks depending on whether someone is seated.
  const OUT = 0.16, TUCK = -0.27
  const deskChairs = {}
  const chairMark = (seat, k) => ({ x: seat[0] + Math.sin(seat[2]) * k, z: seat[1] + Math.cos(seat[2]) * k })

  const screenTints = [P.slate, P.navy, P.mauve, P.slate, P.navy, P.mauve]
  let di = 0
  for (const d of desks) {
    if (d.label === 'reception') continue
    const [sx, sz, syaw] = d.seat
    const start = occupied.includes(d.label) ? OUT : TUCK
    const g = chair(group, sx + Math.sin(syaw) * start, sz + Math.cos(syaw) * start, syaw)
    g.userData.meshes.forEach(o => meshes.push(o))
    deskChairs[d.label] = { group: g, out: chairMark(d.seat, OUT), tuck: chairMark(d.seat, TUCK) }
    // Monitor on the far side of the desk top from the sitter.
    const gx = d.group.position.x, gz = d.group.position.z
    monitor(group, gx - Math.sin(syaw) * 0.20, gz - Math.cos(syaw) * 0.20,
      syaw, deskTop, screenTints[di % screenTints.length]).forEach(o => meshes.push(o))
    di++
  }
  // Reception gets a chair and paper trays instead of a monitor.
  const rec = desks.find(d => d.label === 'reception')
  if (rec) {
    const [rx, rz, ryaw] = rec.seat
    const g = chair(group, rx + Math.sin(ryaw) * OUT, rz + Math.cos(ryaw) * OUT, ryaw, P.mauve)
    g.userData.meshes.forEach(o => meshes.push(o))
    deskChairs[rec.label] = { group: g, out: chairMark(rec.seat, OUT), tuck: chairMark(rec.seat, TUCK) }
    add(trays(group, rec.group.position.x + 0.30, 0.95, rec.group.position.z + 0.55, ryaw))
  }

  // --- walls and corners ---------------------------------------------------
  add(phoneNook(group, 5.4, -5.0, wallZ))
  // Clear of the whiteboard, which spans x -2.98 to 0.18 on the same wall.
  add(wallArt(group, [-4.5, 1.5], wallZ))

  // Left wall: storage, which is also what fills the biggest empty stretch.
  add(shelf(group, wallX + 0.28, -3.0, Math.PI / 2, 1.7, 1.9))
  add(shelf(group, wallX + 0.28, 3.1, Math.PI / 2, 1.5, 1.55))
  add(plant(group, wallX + 0.55, -5.6, 1.1))
  add(plant(group, wallX + 0.55, 6.0, 0.9))

  // Back wall corner nearest the desks, and a plant to break the long run.
  add(plant(group, -4.6, wallZ + 0.6, 1.0))
  add(console_(group, 2.0, wallZ + 0.32, 0, 1.5, 0.66))
  add(trays(group, 2.0, 0.70, wallZ + 0.32, 0))

  // The open +x edge gets a water cooler and a plant rather than the crate
  // stack that was here first — that stack sat exactly where two of the demo
  // cast park, so they spawned inside it. Both of these are clear of the park
  // marks and of the crates and fire rings.
  const cooler = new THREE.Group()
  const cOut = []
  box(cOut, mat('coolerBody', P.cream), 0.34, 0.95, 0.34, 0, 0.475, 0)
  box(cOut, mat('coolerBase', P.slate), 0.38, 0.10, 0.38, 0, 0.05, 0)
  cyl(cOut, mat('coolerJug', 0x9CC4D6), 0.15, 0.42, 0, 1.16, 0)
  cOut.forEach(o => cooler.add(o))
  cooler.position.set(8.35, 0, -3.5)
  group.add(cooler)
  cOut.forEach(o => meshes.push(o))
  add(plant(group, 8.4, 5.4, 1.05))

  // Lounge on the rug at (1.4, 3.3). Clear of the tortoise's demo path along
  // z = 6.15 and of the ducks and hammock rings.
  add(lounge(group, 1.5, 3.2))

  return { group, meshes, deskChairs }
}
