// Pure helpers for turning git log/blame data into pixels: author->colour
// hashing (blamecard.js can't import palette.ts — this path is unbundled
// plain JS, palette.ts is TS for the bundled side) and a rough relative-age
// parser so commits can be placed on a timeline axis. No DOM, no fetch —
// kept pure so blamecard-test.html and vitest can exercise it without a
// browser or a running git repo.

// Same shape as palette.ts's hairFor() hash (multiply-by-31, unsigned) but
// mapped to a full hue circle instead of picking from a fixed swatch list —
// blame authors aren't a bounded cast of six, could be anyone in `git log`.
export function hashString(s) {
  let h = 0
  const str = String(s || '')
  for (let i = 0; i < str.length; i++) h = (h * 31 + str.charCodeAt(i)) >>> 0
  return h
}

export function hueForAuthor(name) {
  return hashString(name) % 360
}

// lightness/saturation pinned so every author lands in the same muted,
// legible band as the rest of the office palette — no neon hashes.
export function colorForAuthor(name, { light = 52, sat = 46 } = {}) {
  return `hsl(${hueForAuthor(name)} ${sat}% ${light}%)`
}

const REL_UNIT_DAYS = {
  second: 1 / 86400, seconds: 1 / 86400,
  minute: 1 / 1440, minutes: 1 / 1440,
  hour: 1 / 24, hours: 1 / 24,
  day: 1, days: 1,
  week: 7, weeks: 7,
  month: 30, months: 30,
  year: 365, years: 365,
}

// git's `--date=relative` gives strings like "3 days ago", "yesterday",
// "2 years, 1 month ago", "right now". Good enough for placing a dot on an
// axis; the exact string is still what's shown on hover, this is never
// displayed as-is.
export function parseRelativeAge(when) {
  if (typeof when !== 'string' || !when.trim()) return null
  const w = when.toLowerCase()
  if (/right now|^now$/.test(w)) return 0
  if (/^yesterday/.test(w)) return 1
  let total = 0
  let matched = false
  const re = /(\d+)\s+(second|seconds|minute|minutes|hour|hours|day|days|week|weeks|month|months|year|years)/g
  let m
  while ((m = re.exec(w))) {
    matched = true
    total += parseInt(m[1], 10) * REL_UNIT_DAYS[m[2]]
  }
  return matched ? total : null
}

// Position on a 0..1 axis, newest at 1 (right), oldest at 0 (left). Log
// scale so a cluster of this-week commits doesn't collapse into one pixel
// next to a three-year-old one — a repo's history skews young at the tip.
export function ageToX(days, maxDays) {
  const d = Math.max(0, days ?? 0)
  const m = Math.max(1, maxDays ?? (d || 1))
  const t = 1 - Math.log1p(d) / Math.log1p(m)
  return Math.max(0, Math.min(1, t))
}

// ageToX is deterministic, so a file with 8 commits all "2 days ago" maps
// to eight dots at the exact same x — they render as one. This groups ages
// that would land within `slop` of each other on the 0..1 axis into a
// single bucket and hands back one entry per input age (same order), each
// carrying which bucket it's in and its position inside it, so the caller
// can offset colliding dots and badge the bucket with a count instead of
// silently dropping commits on the floor.
export function stackTimelinePositions(ages, maxDays, slop = 0.022) {
  const items = (ages || []).map((d, i) => ({ i, x: ageToX(d, maxDays) }))
  const sorted = [...items].sort((a, b) => a.x - b.x)
  const buckets = []
  for (const it of sorted) {
    const last = buckets[buckets.length - 1]
    // compare against the bucket's anchor (its first member), not the
    // previous item, so a long run of close-but-not-identical ages can't
    // chain into one giant bucket a slop-width at a time
    if (last && it.x - last.items[0].x <= slop) {
      last.items.push(it)
    } else {
      buckets.push({ items: [it] })
    }
  }
  const out = new Array(items.length)
  for (const b of buckets) {
    const bucketX = b.items.reduce((s, it) => s + it.x, 0) / b.items.length
    b.items.forEach((it, pos) => {
      out[it.i] = { x: bucketX, bucketSize: b.items.length, bucketPos: pos }
    })
  }
  return out
}
