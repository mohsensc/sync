// Caption arbiter for #63: office.html's demo and a reel replay both want
// to drive the same #caption element, and without a referee the demo's
// next scripted line can silently stomp a replay's caption mid-read — the
// bug is a race, not a crash, so it only shows up as "the words on screen
// were wrong," which is exactly why it slipped past round after round.
//
// A pure priority holder, no DOM here (same split reel.js/live.js already
// use: logic first, thin DOM layer wired on top in office.html). Replay
// always wins over demo. Once a replay takes the hold, demo writes are
// dropped on the floor — not queued, not merged, just ignored — until the
// hold is released, which office.html does the instant the replay
// encounter's phase hits 'done' (see the render-loop check next to
// releaseCameraFocus).
//
// Two priority levels is all this needs today (demo, replay). If a third
// caption source ever shows up, this can grow, but nothing about the
// current shape hardcodes there being exactly two.

export const PRIORITY = { demo: 0, replay: 1 }

export function createCaptionArbiter(write) {
  let holderPriority = null   // priority currently holding the caption, or null
  let holdId = null           // opaque token so release() can't drop someone else's hold

  function set(text, opts = {}) {
    const priority = opts.priority ?? PRIORITY.demo
    if (holderPriority !== null && priority < holderPriority) return false
    write(text)
    return true
  }

  /** Take the caption exclusively at a given priority until release() is
   *  called with the same token. Returns the token. */
  function hold(priority) {
    holderPriority = priority
    holdId = {}
    return holdId
  }

  /** Release a hold. No-ops if `token` isn't the current hold (an already-
   *  superseded or already-released hold releasing late shouldn't clobber
   *  whatever holds it now). */
  function release(token) {
    if (token !== holdId) return
    holderPriority = null
    holdId = null
  }

  function isHeld() { return holderPriority !== null }

  return { set, hold, release, isHeld }
}
