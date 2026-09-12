// Tiptoe: an alternate rung-1 "read-vs-edit" beat, alongside yield.js. Same
// situation — one agent reads while another edits, nobody actually blocked
// — but played for the joke instead of the mild aside: the reader treats a
// read-only glance like a heist, and the editor never once looks up.
//
//   tiptoeSneak  — the reader. Rises onto their toes, arms out for cartoon
//     balance, and rocks through two exaggerated sneaking steps in place
//     (this is a clip, not footwork — see yield.js's own note on why a
//     weight-shift stands in for a real step) with a "shh" finger-to-lips
//     beat in the middle, then holds the tiptoe stance.
//   tiptoeOblivious — the editor. Stays in a typing posture throughout,
//     head down. One small double-tap keystroke twitch partway through —
//     just enough to read as "still working," not a reaction to anything.
//     Deliberately does NOT nod or look up: unlike yieldKeep's brief
//     acknowledgment, the whole joke here is that the editor never notices
//     there was anything to sneak past.
//
// Ends mid-gesture (full tiptoe stance / mid-keystroke), not back at rest —
// same reasoning as slap.js's SETTLE: agent.js's REPLAY_CHAINS layers a
// short procedural sway on top of whatever frame a clip ends on (see
// clips/sustain.js), so the payoff needs to actually BE the held frame,
// not something already relaxing out of it.
//
// WHY THIS FILE BUILDS ITS OWN CLIPS
// Same story as yield.js/handshake.js/argue.js: anim.js exports applyPose
// but not the internals that turn a pose function into an AnimationClip.
// This file builds a scratch rig from anim.js's own BIND data and replays
// applyPose across it, same as those three.
//
// No IK anywhere. Marks are the primitive; the controller owns the pathing.

import * as THREE from 'three'
import * as ANIM from '../anim.js'
import { highfiveMarks, CHARACTER_HEIGHT } from '../highfive.js'

const clamp01 = u => u < 0 ? 0 : u > 1 ? 1 : u
const smooth = u => u * u * (3 - 2 * u)
const wrap = p => ((p % 1) + 1) % 1

/** Periodic raised cosine, same three lines as yield.js's own copy — not
 *  worth reaching into anim.js's private scope for. 1 at centre, 0 outside
 *  width, zero slope at the edges. */
function bump(p, centre, width) {
  const d = wrap(p - centre + 0.5) - 0.5
  const h = width * 0.5
  if (Math.abs(d) >= h) return 0
  return 0.5 * (1 + Math.cos(Math.PI * d / h))
}

/** 0 before `start`, smoothsteps to 1 over `rise`, holds at 1 forever
 *  after — unlike bump(), this does not fall back down. Every "the payoff
 *  has to still be showing at t=1" gesture in this file (the toe-lift, the
 *  facepalm/shrug in facepalm.js) uses this instead. */
function riseHold(t, start, rise) {
  if (t <= start) return 0
  if (t >= start + rise) return 1
  return smooth((t - start) / rise)
}

function pose(...parts) {
  const o = {}
  for (const p of parts) if (p) for (const k in p) o[k] = p[k]
  return o
}

// ---------------------------------------------------------------------------
// Timing
// ---------------------------------------------------------------------------
export const TIPTOE_DUR = 1.85
const RISE_START = 0.05, RISE_WIDTH = 0.28      // up onto toes
const SHH_PEAK = 0.55, SHH_WIDTH = 0.42          // finger-to-lips accent
const STEP_HZ = 2.1                              // sneaking-step rock, cycles over the clip
const STEP_ENV_PEAK = 0.5, STEP_ENV_WIDTH = 0.85 // the rock fades in/out, doesn't run the whole clip

// ---------------------------------------------------------------------------
// tiptoeSneak — the reader
// ---------------------------------------------------------------------------
function tiptoeSneakPose(t) {
  const rise = riseHold(t, RISE_START, RISE_WIDTH)
  const shh = bump(t, SHH_PEAK, SHH_WIDTH)
  const stepEnv = bump(t, STEP_ENV_PEAK, STEP_ENV_WIDTH)
  const rock = Math.sin(t * Math.PI * 2 * STEP_HZ) * stepEnv

  return pose(ANIM.STANDING,
    // Up on the toes: a small hips lift + forward lean, same "weight shift
    // stands in for footwork" convention as yield.js's stepAmp/hipsLiftAmp.
    { hips: [2.5 * rock, 0, 0], Hips: [0, 7 * rise, 0] },
    {
      Spine02: [4 * rise - 1 * shh, 3 * rock, 0],
      Spine01: [3 * rise, 2 * rock, 0],
      Spine:   [2 * rise, 1 * rock, 0],
      neck:    [-2 * rise - 6 * shh, -2 * rock, 0],
      Head:    [-4 * rise - 10 * shh, -3 * rock, 4 * shh],
    },
    // Arms out for cartoon tightrope balance, palms down. The right arm
    // peels off that pose for the shh beat: forearm folds up, hand toward
    // the mouth (approximated at head height, near the neck — this rig has
    // no fingers to actually mime "shh" with).
    {
      LeftShoulder: [0, -3, 6], LeftArm: [-8 + 3 * rock, -14, -78 * rise],
      LeftForeArm: [0, -10, 0], LeftHand: [0, -6, 0], LeftPalm: [0.1, -0.9, 0.2],
      RightShoulder: [0, 3 - 4 * shh, -6 + 30 * shh],
      RightArm: [-8 - 3 * rock - 40 * shh, 14 + 60 * shh, 78 * rise - 60 * shh],
      RightForeArm: [0, 10 + 90 * shh, 0],
      RightHand: [0, 6, 0], RightPalm: [0.1, 0.9, 0.2],
    },
    // Toe-lift stand-in: knees soften and heels rise. No foot IK on this
    // rig (see the office README), so this reads as "rising," not a real
    // planted-toe contact — same honest limitation slap.js/shove.js note
    // for contact geometry.
    {
      LeftUpLeg: [-6 * rise, 2 * rock, 0], RightUpLeg: [-6 * rise, -2 * rock, 0],
      LeftLeg: [10 * rise, 0, 0], RightLeg: [10 * rise, 0, 0],
      LeftFoot: [-14 * rise, 0, 0], RightFoot: [-14 * rise, 0, 0],
    })
}

// ---------------------------------------------------------------------------
// tiptoeOblivious — the editor, never looks up
// ---------------------------------------------------------------------------
const KEEP_ARMS = {
  LeftArm:  [-38, -6, -60], RightArm:  [-38, 6, 60],
  LeftForeArm: [0, -70, 0], RightForeArm: [0, 70, 0],
  LeftHand: [10, -4, 0],    RightHand: [10, 4, 0],
  LeftPalm: [0.1, -0.9, -0.4], RightPalm: [0.1, 0.9, -0.4],
}
const TAP_PEAK = 0.62, TAP_WIDTH = 0.10

function tiptoeObliviousPose(t) {
  // A small double-tap: two narrow bumps close together, not one wide one —
  // reads as a couple of keystrokes, not a single flinch.
  const tap = bump(t, TAP_PEAK, TAP_WIDTH) + bump(t, TAP_PEAK + 0.08, TAP_WIDTH) * 0.7
  return pose(ANIM.STANDING, KEEP_ARMS, {
    RightForeArm: [0, 70 - 8 * tap, 0],
    RightHand: [4 * tap, 4, 0],
    Spine02: [1, 0, 0], neck: [3, 0, 0], Head: [5, 0, 0],
  })
}

// 28 keys over 1.85s is ~66ms/sample — plenty for motion this slow (the
// fastest thing here is the double-tap, ~0.10 clip-width wide, comfortably
// sampled at that rate; nothing in this file needs slap.js's contact-frame
// precision).
const TIPTOE_KEYS = 28
export const TIPTOE_SPEC = { fn: tiptoeSneakPose, dur: TIPTOE_DUR, keys: TIPTOE_KEYS, loop: false }
export const TIPTOE_OBLIVIOUS_SPEC = { fn: tiptoeObliviousPose, dur: TIPTOE_DUR, keys: TIPTOE_KEYS, loop: false }

export const registry = { tiptoe: TIPTOE_SPEC, tiptoeOblivious: TIPTOE_OBLIVIOUS_SPEC }

// Folded into anim.js's own CLIPS table at import time, so these play by name
// through ANIM.crossfade like every other clip — one clip table, one owner of
// the mixer's weights. See anim.js's CLIPS header for the timing rule (the
// merge has to happen before the first createClips(), which import time is).
Object.assign(ANIM.CLIPS, registry)



// ---------------------------------------------------------------------------
// Spacing and marks — not a contact action, chosen directly, same
// reasoning as yield.js's YIELD_SPACING. A hair wider than yield's 0.62:
// this is a "sneaking past," which reads better with a little more room
// to sneak through than a face-to-face aside needs.
// ---------------------------------------------------------------------------
export const TIPTOE_SPACING = 0.78

export function spacingFor(height = CHARACTER_HEIGHT) {
  return TIPTOE_SPACING * (height / CHARACTER_HEIGHT)
}

export function tiptoeMarks(aPos, bPos, spacing = TIPTOE_SPACING) {
  return highfiveMarks(aPos, bPos, spacing)
}
