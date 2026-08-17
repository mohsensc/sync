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

// "5 days" / "2 months" — short relative-age phrasing shared by the bar
// variants (region/single-owner summaries) and the story variant's prose.
// Was a private copy inside blamecard.js; moved here once the story
// variant needed the exact same phrasing so there's one place that decides
// what "old" sounds like, not two that could drift apart.
export function formatAge(days) {
  if (days == null) return null
  if (days <= 0) return 'today'
  if (days === 1) return '1 day'
  if (days < 30) return `${days} days`
  if (days < 365) return `${Math.round(days / 30)} months`
  return `${Math.round(days / 365)} years`
}

// Every caller that wraps a formatAge() label in " ago" or " old" has to
// skip that suffix on the one bucket that already reads as a complete
// phrase — "today" — or the office's single most common case (a file
// touched the day you're looking at it) renders as "last touched today
// ago" / "newest today old". One function owns that exception so it can't
// drift into four separate copies of the same "if today" check at each
// call site.
export function agePhrase(ageLabel, suffix) {
  if (ageLabel == null) return null
  return ageLabel === 'today' ? ageLabel : `${ageLabel} ${suffix}`
}

// Coarser than formatAge: for spans ("N commits over ___") rather than a
// point in time, so "1 day" reads as "over a day" and small day counts
// don't feel falsely precise.
function formatSpan(days) {
  if (days == null || days <= 0) return null
  if (days < 2) return 'under a day'
  if (days < 14) return `${Math.round(days)} days`
  if (days < 60) return `${Math.round(days / 7)} weeks`
  if (days < 730) return `${Math.round(days / 30)} months`
  return `${Math.round(days / 365)} years`
}

// ---------------------------------------------------------------------
// story variant — turns stat/log/blame into two or three prose sentences
// instead of an ownership bar. Pure so blamecard-test.html and vitest can
// exercise every degrade path without a browser or a running git repo.
// Built for the demo repo's actual shape: post email-dedup most files here
// are single-author, which makes the graphic/classic ownership bar a
// 100%-one-color rectangle that says nothing — this composes the same real
// data into a sentence instead of asking the viewer to read a solid bar.
// ---------------------------------------------------------------------

/** stat/log/blame -> {lines, commits}. `lines` is 1-3 plain sentences,
 *  never empty (worst case is one line saying there's no history);
 *  `commits` is the log entries as-is, for the classic list underneath. */
export function composeStory(stat, log, blame) {
  const entries = (log && log.ok && Array.isArray(log.entries)) ? log.entries : []
  const owners = (blame && blame.ok && Array.isArray(blame.owners)) ? blame.owners : []
  const statOk = !!(stat && stat.ok)
  const commitCount = statOk && Number.isFinite(stat.commits) ? stat.commits : entries.length

  if (!commitCount && !owners.length) {
    return { lines: ['no history here yet'], commits: [] }
  }

  const top = owners.length ? [...owners].sort((a, b) => (b.share || 0) - (a.share || 0))[0] : null
  const ownerName = top ? top.author : (statOk ? stat.lastAuthor : null)

  const lines = []

  if (commitCount === 1) {
    // the single-commit case reads as one plain fact, not "mostly X" —
    // there's no "mostly" when there's only one commit to be mostly of
    const only = entries[0]
    const age = agePhrase(formatAge(statOk ? stat.lastAgeDays : (only ? parseRelativeAge(only.when) : null)), 'ago')
    const author = ownerName || (only && only.author) || null
    const parts = ['one commit', age, author].filter(Boolean)
    lines.push(parts.join(', ') + '.')
  } else {
    const ownerPhrase = owners.length > 1
      ? `Mostly ${ownerName} (${Math.round((top.share || 0) * 100)}%)`
      : ownerName ? `Written entirely by ${ownerName}` : null
    const span = statOk ? formatSpan(stat.firstAgeDays) : null
    const lastAge = agePhrase(formatAge(statOk ? stat.lastAgeDays : (entries[0] ? parseRelativeAge(entries[0].when) : null)), 'ago')
    const volumeBits = [
      commitCount ? `${commitCount} commits` : null,
      span ? `over ${span}` : null,
    ].filter(Boolean).join(' ')
    const lastBit = lastAge ? `last touched ${lastAge}` : null
    const volumePhrase = [volumeBits, lastBit].filter(Boolean).join(', ')

    if (ownerPhrase && volumePhrase) lines.push(`${ownerPhrase} — ${volumePhrase}.`)
    else if (ownerPhrase) lines.push(`${ownerPhrase}.`)
    else if (volumePhrase) lines.push(`${volumePhrase[0].toUpperCase()}${volumePhrase.slice(1)}.`)
  }

  // Busiest stretch: only worth a sentence when the visible commits (the
  // handful `log` actually fetched, not full history) show a real cluster
  // — two or more landing within the same week of each other. No absolute
  // calendar dates come back from git --date=relative, so this speaks in
  // "about N weeks back" rather than faking a "week of Jul 7".
  const ages = entries.map(e => parseRelativeAge(e.when)).filter(d => d != null)
  if (ages.length > 2) {
    const weeks = new Map()
    for (const d of ages) {
      const wk = Math.floor(d / 7)
      weeks.set(wk, (weeks.get(wk) || 0) + 1)
    }
    let busiest = null
    weeks.forEach((count, wk) => {
      if (count > 1 && (!busiest || count > busiest.count)) busiest = { wk, count }
    })
    if (busiest) {
      const when = busiest.wk === 0 ? 'this week' : `about ${busiest.wk} week${busiest.wk === 1 ? '' : 's'} back`
      lines.push(`Busiest stretch: ${busiest.count} commits ${when}.`)
    }
  }

  return { lines, commits: entries }
}
