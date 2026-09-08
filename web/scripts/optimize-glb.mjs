#!/usr/bin/env node
// Slims the GLBs in public/glb into public/glb-lite with gltf-transform's JS API
// (not the CLI binary, so ratios/errors live in one place and are easy to retune).
//
// Blender is deliberately not part of this: not installed here, it runs the same
// quadric-edge-collapse algorithm gltf-transform's simplify does, and it can't
// decimate the skinned character without a re-rig.
//
// Per-asset numbers below came out of a manual sweep (see the office README):
//   - character.glb is 31,222 skinned tris behind one 2048 PNG used as both
//     baseColor and emissive.
//   - the five static props are 9-12k tris each behind a 2048 JPEG.
//   - cable-ball is error-bound: it barely decimates below error ~0.01-0.02.
//   - quantize shifted the skinned character's bbox in an earlier run, so an
//     asset that carries a skin doesn't get it. That is read off the document
//     (countSkinnedPrimitives), not declared per asset. Everything else is
//     quantized (three's GLTFLoader reads KHR_mesh_quantization and
//     EXT_texture_webp natively, no decoder needed); draco and meshopt are out
//     either way, since the app's five GLTFLoader sites wire up no decoder.
//   - BBOX_TOLERANCE is a budget, not a target: an asset that misses it throws
//     and nothing is written. There is no per-asset escape from it.
//
// Run: pnpm optimize-glb [asset.glb ...]   (defaults to every asset in the table)

import { NodeIO, Primitive } from '@gltf-transform/core'
import { ALL_EXTENSIONS } from '@gltf-transform/extensions'
import {
  weld,
  simplify,
  prune,
  dedup,
  textureCompress,
  quantize,
  getBounds,
  getGLPrimitiveCount,
  getSceneVertexCount,
  VertexCountMethod,
} from '@gltf-transform/functions'
import { MeshoptSimplifier } from 'meshoptimizer'
import sharp from 'sharp'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const SRC_DIR = path.resolve(__dirname, '../public/glb')
const OUT_DIR = path.resolve(__dirname, '../public/glb-lite')

const BBOX_TOLERANCE = 0.001 // 0.1%, measured against the source bbox diagonal

// Texture slots that are safe to recompress. Normal maps are excluded on
// purpose ("keep normals") -- they're not color data and read as noisy at
// webp's quality levels.
const COMPRESSIBLE_SLOTS = /color|metallicRoughness|emissive|occlusion/i

// name -> simplify ratio/error. Every asset is held to the same bbox budget,
// so the error is whatever the largest value is that still clears it.
// desk-tripo-12k and vault-door hold their bbox at error 0.01. phone-wall and
// tortoise-v2 didn't -- 0.01 ate a real corner (0.42% / 0.12% drift), not just
// a spiky extremity, so they're tightened until the drift check clears; that
// costs some of the triangle reduction back (see the table this prints).
// cable-ball is the stubborn one: swept at ratio 0.3 with quantize on,
// error 0.02 drifts 1.4058% (2797 tris), 0.01 drifts 0.8786% (4595), and
// 0.005 is the first that clears at 0.0004% -- 9328 source tris down to 7295,
// 453KB. That is most of its reduction given back, and it is what the budget
// costs on this asset. Anything looser eats a whole cable loop off the ball.
// tex overrides the shared texture budget below. Only the character needs one:
// it's the only asset the camera ever gets close to (framing.js HEAD_DIST is
// 0.24 m), and at 1024/q82 webp mottled the flat hair colour and chewed the
// hair/skin edge -- obvious at that distance, invisible on a prop across the
// room. The prop budget is unchanged.
const ASSETS = {
  'character.glb': { ratio: 0.4, error: 0.002, tex: { size: 2048, quality: 92 } },
  'desk-tripo-12k.glb': { ratio: 0.3, error: 0.01 },
  'phone-wall.glb': { ratio: 0.3, error: 0.005 },
  'tortoise-v2.glb': { ratio: 0.3, error: 0.002 },
  'vault-door.glb': { ratio: 0.3, error: 0.01 },
  'cable-ball.glb': { ratio: 0.3, error: 0.005 },
}
const TEXTURE_SIZE = 1024
const TEXTURE_QUALITY = 82

function bboxDiagonal(b) {
  return Math.hypot(b.max[0] - b.min[0], b.max[1] - b.min[1], b.max[2] - b.min[2])
}

// Worst-case corner drift, relative to the original bbox's diagonal (so a
// prop that sits far from the origin doesn't get a falsely lenient ratio).
function maxBboxDrift(before, after, scale) {
  let drift = 0
  for (let i = 0; i < 3; i++) {
    drift = Math.max(drift, Math.abs(before.min[i] - after.min[i]) / scale)
    drift = Math.max(drift, Math.abs(before.max[i] - after.max[i]) / scale)
  }
  return drift
}

function countTris(document) {
  let tris = 0
  for (const mesh of document.getRoot().listMeshes()) {
    for (const prim of mesh.listPrimitives()) {
      if (prim.getMode() === Primitive.Mode.TRIANGLES) tris += getGLPrimitiveCount(prim)
    }
  }
  return tris
}

function snapshot(document, bytes) {
  const scene = document.getRoot().listScenes()[0]
  return {
    bytes,
    tris: countTris(document),
    verts: getSceneVertexCount(scene, VertexCountMethod.UPLOAD),
    bounds: getBounds(scene),
  }
}

// Every primitive that carries a skin, by mesh+primitive index, plus enough
// info to catch simplify/prune/dedup silently dropping the skin data.
// Counts primitives carrying both JOINTS_0 and WEIGHTS_0 -- not indexed by
// position, since weld/simplify/prune/dedup are free to reorder or merge
// primitives. Good enough for these single-mesh assets; would need real
// identity tracking (extras id, say) to survive a multi-mesh skinned asset.
function countSkinnedPrimitives(document) {
  let count = 0
  for (const mesh of document.getRoot().listMeshes()) {
    for (const prim of mesh.listPrimitives()) {
      if (prim.getAttribute('JOINTS_0') && prim.getAttribute('WEIGHTS_0')) count++
    }
  }
  return count
}

// Throws if fewer primitives carry JOINTS_0/WEIGHTS_0 after the transform
// than before, or if weight sums have drifted off 1.0 (a symptom of losing
// skin data during a vertex-merging step rather than genuinely dropping it).
function verifySkinSurvived(name, countBefore, document) {
  if (countBefore === 0) return
  const countAfter = countSkinnedPrimitives(document)
  if (countAfter < countBefore) {
    throw new Error(`${name}: ${countBefore} skinned primitive(s) before, only ${countAfter} after`)
  }
  for (const mesh of document.getRoot().listMeshes()) {
    for (const prim of mesh.listPrimitives()) {
      const weights = prim.getAttribute('WEIGHTS_0')
      if (!prim.getAttribute('JOINTS_0') || !weights) continue
      const el = weights.getElementSize()
      const target = new Array(el).fill(0)
      const sampleStride = Math.max(1, Math.floor(weights.getCount() / 200)) // ~200 spot checks
      for (let i = 0; i < weights.getCount(); i += sampleStride) {
        weights.getElement(i, target)
        const sum = target.reduce((a, b) => a + b, 0)
        if (Math.abs(sum - 1) > 0.02) {
          throw new Error(`${name}: weight sum ${sum.toFixed(4)} at vertex ${i} strayed from 1.0`)
        }
      }
    }
  }
}

async function processAsset(name, cfg) {
  const srcPath = path.join(SRC_DIR, name)
  const outPath = path.join(OUT_DIR, name)
  const io = new NodeIO().registerExtensions(ALL_EXTENSIONS)

  const srcBytes = fs.statSync(srcPath).size
  const document = await io.read(srcPath)
  const before = snapshot(document, srcBytes)
  const skinnedCountBefore = countSkinnedPrimitives(document)

  await document.transform(
    weld(),
    simplify({ ratio: cfg.ratio, error: cfg.error, simplifier: MeshoptSimplifier }),
    prune(),
    dedup(),
  )

  verifySkinSurvived(name, skinnedCountBefore, document)

  const scale = Math.max(bboxDiagonal(before.bounds), 1e-6)

  const texSize = (cfg.tex && cfg.tex.size) || TEXTURE_SIZE
  const texQuality = (cfg.tex && cfg.tex.quality) || TEXTURE_QUALITY
  await document.transform(
    textureCompress({
      encoder: sharp,
      targetFormat: 'webp',
      resize: [texSize, texSize],
      quality: texQuality,
      slots: COMPRESSIBLE_SLOTS,
    }),
  )

  // Quantizing a skinned mesh moved the character's bbox in an earlier run,
  // so the assets that carry a skin don't get it. Read off the document, not
  // declared per asset -- it is the same question verifySkinSurvived asks.
  if (skinnedCountBefore === 0) await document.transform(quantize())

  // Drift is checked before the write, not after: a fatal one used to leave
  // the rejected file sitting in glb-lite/ for the scene to load.
  const finalBounds = getBounds(document.getRoot().listScenes()[0])
  const totalDrift = maxBboxDrift(before.bounds, finalBounds, scale)
  if (totalDrift > BBOX_TOLERANCE) {
    // A bbox this far off means simplify ate a whole corner. The asset's
    // error comes down until it clears -- that is what the budget is for.
    // Note this only catches geometry that moves the box: a collapsed nose or
    // a faceted hair silhouette costs nothing here and needs an eyeball.
    throw new Error(
      `${name}: final bbox drifted ${(totalDrift * 100).toFixed(4)}% from the source (> 0.1%) -- ` +
      `min ${JSON.stringify(before.bounds.min)} -> ${JSON.stringify(finalBounds.min)}, ` +
      `max ${JSON.stringify(before.bounds.max)} -> ${JSON.stringify(finalBounds.max)}`,
    )
  }

  fs.mkdirSync(OUT_DIR, { recursive: true })
  await io.write(outPath, document)

  const after = snapshot(document, fs.statSync(outPath).size)

  return { name, before, after, totalDrift }
}

function fmtBytes(n) {
  return `${(n / 1024).toFixed(0)}KB`
}

function pct(before, after) {
  if (before === 0) return 'n/a'
  return `${(((after - before) / before) * 100).toFixed(1)}%`
}

function printTable(results) {
  const rows = results.map((r) => ({
    asset: r.name,
    'bytes before': fmtBytes(r.before.bytes),
    'bytes after': fmtBytes(r.after.bytes),
    'bytes delta': pct(r.before.bytes, r.after.bytes),
    'tris before': r.before.tris,
    'tris after': r.after.tris,
    'verts before': r.before.verts,
    'verts after': r.after.verts,
    'bbox drift': `${(r.totalDrift * 100).toFixed(4)}%`,
  }))
  console.table(rows)
  for (const r of results) {
    console.log(
      `${r.name}: bbox before min=${JSON.stringify(r.before.bounds.min)} max=${JSON.stringify(r.before.bounds.max)}`,
    )
    console.log(
      `${' '.repeat(r.name.length)}  bbox after  min=${JSON.stringify(r.after.bounds.min)} max=${JSON.stringify(r.after.bounds.max)}`,
    )
  }
}

async function main() {
  const requested = process.argv.slice(2)
  const names = requested.length > 0 ? requested : Object.keys(ASSETS)

  const results = []
  for (const name of names) {
    const cfg = ASSETS[name]
    if (!cfg) throw new Error(`unknown asset "${name}", expected one of: ${Object.keys(ASSETS).join(', ')}`)
    console.log(`optimizing ${name} (ratio=${cfg.ratio} error=${cfg.error})...`)
    results.push(await processAsset(name, cfg))
  }

  printTable(results)

  const totalBefore = results.reduce((a, r) => a + r.before.bytes, 0)
  const totalAfter = results.reduce((a, r) => a + r.after.bytes, 0)
  console.log(`\ntotal: ${fmtBytes(totalBefore)} -> ${fmtBytes(totalAfter)} (${pct(totalBefore, totalAfter)})`)
}

main().catch((err) => {
  console.error(err.stack || err.message)
  process.exit(1)
})
