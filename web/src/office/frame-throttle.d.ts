// Hand-written types for frame-throttle.js. See history-viz.d.ts / ghost.d.ts
// for why office/*.js needs one of these before a typechecked test can
// import it — this path is unbundled plain JS, not part of tsconfig's
// allowJs surface.

/** Call with the frame's own dt every frame. Returns 0 while less than one
 *  period has accumulated; once it has, returns the real accumulated
 *  elapsed time in seconds (not a fixed period) and resets. */
export function makeAmbientThrottle(hz?: number): (dt: number) => number
