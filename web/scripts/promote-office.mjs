#!/usr/bin/env node
// vite build's html output mirrors the entry's source path, so building
// src/office/office.html lands at dist/src/office/office.html, not
// dist/index.html — there's no vite option to flatten a single custom entry
// to the output root. This just moves it there after the fact. Nothing
// inside the file needs rewriting: vite's default base is '/', so every
// injected asset src is already root-absolute, not relative to the html's
// own folder.
import { existsSync, mkdirSync, renameSync, rmSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const distDir = path.resolve(here, '../dist')
const built = path.join(distDir, 'src/office/office.html')
const targetDir = path.join(distDir, 'office')
const target = path.join(targetDir, 'index.html')

if (!existsSync(built)) {
  throw new Error(`expected ${built} from vite build (check vite.config.js's build.rollupOptions.input)`)
}
mkdirSync(targetDir, { recursive: true })
renameSync(built, target)
rmSync(path.join(distDir, 'src'), { recursive: true, force: true })
console.log('promoted office.html to dist/office/index.html')
