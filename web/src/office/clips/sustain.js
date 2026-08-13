// Shared "end-pose hold" for resolution beats — the reel's replay chains
// (see agent.js's REPLAY_CHAINS / REPLAY_VARIANT_STAGE), not the standalone
// World methods. Round 4's motion review, verbatim: "2.5s total, no hold,
// the joke never lands." Every contact clip (slap.js, shove.js,
// chestbump.js, ...) already ends right on its own settle/dazed pose and
// stops there — the mixer clamps on the last frame, technically, but a
// clamped last frame reads as a freeze, not a character standing there.
// The brief wants weight settling and a small idle sway for whoever came
// out ahead, and a slower, heavier sag for whoever didn't — not a dead
// freeze.
//
// This is pure pose math, nothing bone-specific to any one beat and no rig
// of its own: it reads the pose a clip already ends on straight off that
// clip's own registry entry (every clip module in this directory shares
// the exact same `{ fn, dur, keys, loop }` registry shape, so `someName.
// fn(1)` always works) and layers a small sinusoidal sway on top of a
// handful of torso/hips channels. That is the one thing every resolution
// act wants done identically, which is why — unlike the contact clips
// themselves, which don't look anything alike and each earn their own
// bespoke file — this is shared once instead of copy-pasted eight times.
// Register the result straight into ANIM.CLIPS (see agent.js) and it runs
// through anim.js's own buildClip()/getClip() like any other clip; no
// second scratch rig needed, because this never touches THREE directly.

const clamp01 = u => u < 0 ? 0 : u > 1 ? 1 : u

/**
 * Build a ClipSpec that lingers on `pose` for `sustainSec`, swaying gently
 * instead of holding dead still.
 *
 * @param {Record<string, number[]>} pose  a full pose dict, as returned by
 *   any clip module's own `registry.<name>.fn(1)` — the frame this hold
 *   should linger on. Every key is carried through unchanged except the
 *   few this function perturbs, so whatever the source clip left an arm or
 *   a struck cheek doing keeps doing it.
 * @param {number} sustainSec  1 to 1.5 per the brief.
 * @param {'settle'|'deflate'} role  'settle': a confident, slightly quicker
 *   weight shift — the side that came out ahead. 'deflate': slower and a
 *   touch heavier, reads as still absorbing it — the side that stood down
 *   or lost. Same shape either way, different timing and amplitude.
 * @param {number} keys  sample count. Motion here is slow and low-frequency
 *   (well under 1Hz), so this can run much sparser than a contact clip's
 *   own keys without mushing — 16 is plenty.
 */
export function holdSpec(pose, sustainSec, role = 'settle', keys = 16) {
  const cfg = role === 'deflate'
    ? { lean: 0.85, leanHz: 0.42, bob: 0.30, bobHz: 0.30, easeIn: 0.30, phase: 1.9 }
    : { lean: 0.55, leanHz: 0.62, bob: 0.42, bobHz: 0.52, easeIn: 0.16, phase: 0 }

  function fn(t01) {
    const ease = Math.min(1, t01 / cfg.easeIn)
    const s = Math.sin(t01 * Math.PI * 2 * cfg.leanHz + cfg.phase) * cfg.lean * ease
    const b = Math.sin(t01 * Math.PI * 2 * cfg.bobHz + cfg.phase * 1.7) * cfg.bob * ease
    const out = {}
    for (const k in pose) out[k] = pose[k].slice()
    // Lean: a small sagittal rock through the torso chain, tapering off
    // toward the neck so the head doesn't bobble more than the spine does.
    if (out.Spine02) out.Spine02 = [out.Spine02[0] + s, out.Spine02[1], out.Spine02[2]]
    if (out.Spine01) out.Spine01 = [out.Spine01[0] + s * 0.6, out.Spine01[1], out.Spine01[2]]
    if (out.neck) out.neck = [out.neck[0] + s * 0.4, out.neck[1], out.neck[2]]
    // Bob: a slow vertical breathing drift on the hips offset, in cm like
    // every other `hips` entry in this codebase.
    if (out.hips) out.hips = [out.hips[0], out.hips[1] + b, out.hips[2]]
    return out
  }
  return { fn, dur: sustainSec, keys, loop: false }
}

/** `holdSpec` reads a still frame off an existing registry entry — this is
 *  just that lookup, named so call sites (agent.js) read as intent
 *  ("the pose X already ends on") rather than a bare `.fn(1)`. */
export function endPose(spec) {
  return spec.fn(1)
}

/**
 * A pair of hold specs, deflate on `role === 'deflate'`. Convenience for
 * the common case (agent.js registers roughly a dozen of these) of one
 * winner-shaped hold and one loser-shaped hold off the same source
 * registry — `regA`/`nameA` settle, `regB`/`nameB` deflate.
 */
export function holdPair(sourceReg, nameA, nameB, sustainSec) {
  return {
    a: holdSpec(endPose(sourceReg[nameA]), sustainSec, 'settle'),
    b: holdSpec(endPose(sourceReg[nameB]), sustainSec, 'deflate'),
  }
}

/** Symmetric case (highfive/chestbump/fistbump/doubletake): one hold spec,
 *  both sides play it, both 'settle' — nobody lost anything here. */
export function holdSame(sourceReg, name, sustainSec) {
  return holdSpec(endPose(sourceReg[name]), sustainSec, 'settle')
}
