// One shared mechanism for "slow breathing" ambient effects — desk tint,
// hover pulse, churn glow, ghost sway — that don't need a full 60Hz step.
// Each of those used to hand-roll its own dt accumulator; this is the one
// implementation, instantiated once per effect that wants it.
//
// Call the returned function with the frame's own dt every frame. Most
// calls return 0 (falsy — nothing to do yet). Once enough real time has
// piled up, it returns that accumulated time in seconds (truthy) and
// resets. Handing back the ACCUMULATED dt rather than a fixed period
// matters: an effect that advances its phase by the return value ticks at
// the right real-world speed at 20Hz, not at 20Hz-worth-of-33ms-steps —
// the difference between actual elapsed time and a step count that
// happens to fire 20 times a second.
export function makeAmbientThrottle(hz = 20) {
  const period = 1 / hz
  let acc = 0
  return dt => {
    acc += dt
    if (acc < period) return 0
    const elapsed = acc
    acc = 0
    return elapsed
  }
}
