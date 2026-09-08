// Hand-written types for anim.js, same reason highfive.d.ts and yield.d.ts
// exist: office/ *.js runs unbundled and untyped in the browser and isn't part
// of tsconfig's allowJs surface, so a .ts test needs a declaration to reach it.
// Not a full surface for anim.js — the clip modules' geometry tests only ask
// it for a built clip. Extend it if a future test needs more.

import type * as THREE from 'three'

/** Every clip is a {fn, dur, keys, loop} spec; the clips/ modules fold their
 *  own registries into this table at import time. */
export const CLIPS: Record<string, { dur: number; keys: number; loop: boolean }>

/** The baked AnimationClip for a name in CLIPS, built once per character seed. */
export function getClip(name: string, seed?: number): THREE.AnimationClip
