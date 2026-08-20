// Head-zoom framing math, split out of office.html (#64). The room's orbit
// arc and the two head-zoom targets used to live inline there as one big
// block; pulled out here so pickFraming can compare them without office.html
// growing a second copy of clampYaw's wrap math to do it.

// The room is a cutaway, open on +x and +z only. Orbiting past these puts the
// camera behind a wall and the view goes blank, so the arc is clamped.
export const YAW_MIN = 0.18, YAW_MAX = 1.39
export const YAW_MID = (YAW_MIN + YAW_MAX) / 2

/** The representative of y nearest the arc's centre, on the circle. A plain
 *  Math.max/min is periodicity-blind: an angle just past a full turn clamps
 *  to the FAR boundary instead of wrapping back to the near one. The room's
 *  own orbit never noticed because dragging only ever fed this small,
 *  already-nearby deltas — but head framing routinely computes something
 *  like `a.yaw + PI`, which lands anywhere across a full turn, and the arc
 *  here (1.21 rad) is well under PI wide, so "wrap to the representative
 *  nearest the arc's centre" always finds the true closest reachable point
 *  instead of whichever raw number happens to be smaller. clampYaw and
 *  yawMiss both need this and it has to be the same math in both, or "where
 *  does it land" and "how far out was it" could disagree. */
function nearArc(y) {
  const d = ((y - YAW_MID) % (Math.PI * 2) + Math.PI * 3) % (Math.PI * 2) - Math.PI
  return YAW_MID + d
}

/** Clamp a yaw into the room's valid orbit arc — see nearArc for why this
 *  isn't a plain Math.max/min. */
export function clampYaw(y) {
  return Math.max(YAW_MIN, Math.min(YAW_MAX, nearArc(y)))
}

/** How far clampYaw has to displace y to land it in the arc — 0 if y is
 *  already reachable. */
export function yawMiss(y) {
  return Math.abs(clampYaw(y) - nearArc(y))
}

// A character is 1.68 tall; the head sits near the top of that, not at the
// torso height focus() aims at by default. Zooming there needs its own
// close, slightly-off-axis framing — a dead-on close-up on a low-poly face
// reads as a mugshot, a few degrees of yaw off center reads as a look.
export const HEAD_Y = 1.5
export const HEAD_DIST = 0.24
export const HEAD_YAW_OFFSET = 0.16
// The old flight never touched pitch at all — it just carried over whatever
// the room happened to be at, top-down button included. That's the "scalp"
// the reviewer landed on: select someone right after pressing top-down and
// the head zoom stayed looking almost straight down. A close portrait wants
// something closer to eye level.
export const HEAD_PITCH = 0.26
// "Over the shoulder": lower and a little further back than the front
// portrait, so the desk/monitor the character is facing has room in frame.
export const SHOULDER_DIST = 0.27
export const SHOULDER_Y = 1.42
export const SHOULDER_YAW_OFFSET = 0.22
export const SHOULDER_PITCH = 0.16

/**
 * Where the head-zoom camera should land, derived from the character's own
 * facing (a.yaw — external convention, forward is -(sin y, 0, cos y), see
 * zones.js's header note) instead of whatever the room camera happened to be
 * pointed at before the click. That was the bug: landing on a face was luck,
 * because the old flight kept the room's yaw *and* pitch untouched.
 *
 *   'threequarter' (default) — camera sits roughly opposite the character's
 *     forward direction (a.yaw + PI), so it looks back at their face. A few
 *     degrees off dead-on so a head-on close-up doesn't read as a mugshot.
 *   'shoulder' — camera sits roughly behind the character, on their own
 *     forward side (a.yaw), a little further back and lower, framing past
 *     their shoulder toward whatever they're facing.
 *
 * Either result still gets clamped to [YAW_MIN, YAW_MAX] by startFlight. The
 * room is a cutaway open only on +x/+z — a character planted facing the back
 * or left wall genuinely cannot be framed face-on from the camera's side of
 * the room. That clamp is the honest degrade, not a bug still to chase.
 */
export function headFraming(a, mode) {
  if (mode === 'shoulder') {
    return { yaw: a.yaw + SHOULDER_YAW_OFFSET, pitch: SHOULDER_PITCH, dist: SHOULDER_DIST, y: SHOULDER_Y }
  }
  return { yaw: a.yaw + Math.PI + HEAD_YAW_OFFSET, pitch: HEAD_PITCH, dist: HEAD_DIST, y: HEAD_Y }
}

// threequarter is the documented portrait default (see headFraming above) —
// it's what most desks land on once the arc is this narrow, and flipping a
// borderline case to shoulder for a marginal improvement reads as camera
// indecision. So shoulder only wins outright: it has to beat threequarter's
// clamp displacement by more than this margin, not just edge it out.
const PREFER_MARGIN = 0.15

/** Pick threequarter or shoulder for agent a by measuring how far each
 *  candidate yaw is outside the room's reachable arc (#64: threequarter
 *  alone left front-row desks landing on the back of the head, because their
 *  facing puts a.yaw + PI over 90 degrees outside the arc while a.yaw itself
 *  sits right at its edge). Ties and near-ties keep threequarter; shoulder
 *  only takes over when it's clearly the closer shot. */
export function pickFraming(a) {
  const threequarter = headFraming(a, 'threequarter')
  const shoulder = headFraming(a, 'shoulder')
  const threequarterMiss = yawMiss(threequarter.yaw)
  const shoulderMiss = yawMiss(shoulder.yaw)
  return shoulderMiss < threequarterMiss - PREFER_MARGIN ? shoulder : threequarter
}

/** Coerce a ?frame= query value or a setFrame(m) argument to an explicit
 *  pin, or null to fall back to pickFraming. Anything that isn't exactly
 *  'shoulder' or 'threequarter' clears to null — including undefined — so
 *  office.html's setFrame(m) has a way back to the picker default instead of
 *  coercing every non-'shoulder' call into 'threequarter' forever. */
export function resolveFrameMode(m) {
  return m === 'shoulder' || m === 'threequarter' ? m : null
}
