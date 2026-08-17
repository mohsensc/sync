// Blame card: the DOM overlay that slides in when the camera zooms into an
// agent's head. Same pattern as interact.js's #ip/#it — its own injected
// <style>, its own div, nothing added to office.html's markup beyond the
// hook that calls show()/hide().
//
// Data comes from the git-data dev endpoints (see gitapi.mjs): /api/git/blame
// and /api/git/log. Every fetch is defensive — {ok:false}, a network error,
// or the endpoint not existing at all fall through to the same "no history
// here yet" state. Never an empty box.
//
// Four switchable card layouts (press V while a card is open, cycling
// graphic -> classic -> gutter -> story, or load with
// ?bcVariant=classic|gutter|story):
// "graphic" (default for multi-author files) draws ownership as one
// tug-of-war bar and history as a dot timeline; "classic" is the earlier
// per-author-row + text-list treatment, kept around so they can be
// compared side by side rather than thrown away; "gutter" is real source
// lines from /api/git/source with a per-line author gutter tinted from
// blame's &lines=1 shape — the closest thing here to true line-by-line
// blame, falling back to the proportional bar with no error when the
// server or the range doesn't support it (see buildGutterRows); "story"
// replaces the bar with two or three prose sentences composed from real
// stat/log/blame data (composeStory, history-viz.js) and is the default
// for single-author files (see pickDefaultVariant) — a full-width bar
// that just says "mohsensc 100%" conveys nothing a sentence doesn't say
// faster, and post email-dedup that's most files in this repo. See
// STATE.md round-2-task-3 for which one the owner picked, if they picked.
//
// Two more single-purpose treatments layer on top of whichever variant is
// active: a file with exactly one author collapses the ownership section
// to one sentence instead of a bar that would just say "name 100%"
// (isSingleOwner/renderOwnershipSingle — relevant once gitapi.mjs's email
// dedup lands, since that turns most of this demo repo into single-owner
// files); and the history timeline stacks same-age commits into a badged
// bucket instead of rendering eight commits as one dot
// (stackTimelinePositions, in history-viz.js).

import { colorForAuthor, parseRelativeAge, stackTimelinePositions, formatAge, agePhrase, composeStory } from './history-viz.js'

const CSS = `
/* top:328px clears the #hud panel (office.html), which runs from 16px down
   to roughly 300px with its three button rows — the two used to sit on top
   of each other any time a character was selected while the HUD was up. */
#bc{position:fixed;left:18px;top:328px;bottom:16px;transform:translateX(-16px);
  width:280px;overflow-y:auto;overflow-x:hidden;background:#fffdfaf2;
  border:1px solid #C3B39B;border-radius:12px;padding:16px 18px;
  box-shadow:0 14px 40px #4a1f3d26;opacity:0;pointer-events:none;
  transition:opacity .38s ease, transform .38s cubic-bezier(.2,.8,.3,1.1);
  z-index:8;font:13px/1.5 ui-sans-serif,-apple-system,Segoe UI,sans-serif;color:#35455C}
#bc.on{opacity:1;pointer-events:auto;transform:translateX(0)}
#bc h2{font-size:16px;margin:0 0 1px;letter-spacing:-.01em}
#bc .human{font-size:12px;color:#A5738C;margin:0 0 2px}
#bc .path{font:11px ui-monospace,monospace;color:#8A94A3;margin:0 0 12px;
  overflow-wrap:anywhere}
#bc h3{font-size:10px;text-transform:uppercase;letter-spacing:.06em;
  color:#8A94A3;margin:14px 0 7px;display:flex;align-items:center;justify-content:space-between}
#bc h3:first-of-type{margin-top:2px}
#bc .variant-btn{font:10px ui-sans-serif,sans-serif;text-transform:none;letter-spacing:0;
  border:1px solid #E9E0CE;background:#fff;color:#8A94A3;border-radius:5px;
  padding:2px 6px;cursor:pointer}
#bc .variant-btn:hover{background:#E9E0CE;color:#35455C}

/* --- graphic variant: tug-of-war ownership bar --- */
#bc .tug-track{display:flex;height:14px;border-radius:7px;overflow:hidden;
  background:#E9E0CE;box-shadow:inset 0 0 0 1px #C3B39B55}
#bc .tug-seg{height:100%;width:0;transition:width .55s cubic-bezier(.2,.8,.2,1)}
#bc .tug-seg.self{box-shadow:inset 0 0 0 2px #fffdfa99}
#bc .tug-legend{display:flex;flex-wrap:wrap;gap:4px 10px;margin:8px 0 0}
#bc .tug-legend .who{display:flex;align-items:center;gap:5px;font-size:11px;color:#35455C}
#bc .tug-legend .who.self{font-weight:600;color:#C0762A}
#bc .swatch{width:8px;height:8px;border-radius:50%;flex:none}
#bc .pct{color:#8A94A3;font:11px ui-monospace,monospace}

/* --- graphic variant: history timeline --- */
/* height/track-top carry headroom for stacked collisions: same-age commits
   pile upward off the axis (see stackTimelinePositions) instead of
   overlapping on one pixel, up to 6 deep before they start overlapping
   again — good enough, a 7th same-day commit reads as "very busy" either way */
#bc .timeline{position:relative;height:44px;margin:2px 4px 0}
#bc .timeline-track{position:absolute;left:0;right:0;top:38px;height:2px;background:#E9E0CE}
#bc .timeline-axis{display:flex;justify-content:space-between;font:9px ui-sans-serif,sans-serif;
  color:#8A94A3;margin:2px 2px 0}
#bc .timeline-dot{position:absolute;width:10px;height:10px;margin-left:-5px;
  border-radius:50%;border:2px solid #fffdfa;cursor:pointer;transform:scale(0);opacity:0;
  transition:transform .4s cubic-bezier(.34,1.56,.64,1), opacity .3s ease, top .3s ease;
  box-shadow:0 1px 3px #4a1f3d33}
#bc .timeline-dot.in{transform:scale(1);opacity:1}
#bc .timeline-dot:hover,#bc .timeline-dot:focus{transform:scale(1.35)}
#bc .timeline-tip{position:absolute;bottom:100%;left:50%;transform:translate(-50%,-6px);
  background:#35455C;color:#F0ECE6;padding:6px 8px;border-radius:6px;font-size:11px;
  white-space:nowrap;pointer-events:none;opacity:0;transition:opacity .15s ease;z-index:2}
#bc .timeline-tip.on{opacity:1}
#bc .timeline-tip b{display:block;font-size:11px}
#bc .timeline-tip .who2{opacity:.75}
/* the "×N" collision badge on the topmost dot of a stacked bucket */
#bc .timeline-badge{position:absolute;top:-7px;right:-7px;background:#C0762A;color:#fffdfa;
  font:9px/1 ui-sans-serif,sans-serif;font-weight:700;border-radius:8px;padding:2px 4px;
  pointer-events:none;box-shadow:0 1px 2px #4a1f3d40}

/* --- classic variant: stacked per-author rows + text list --- */
#bc .bar-row{display:flex;align-items:center;gap:7px;margin:0 0 6px}
#bc .bar-row .who{width:78px;flex:0 0 78px;font-size:11px;color:#35455C;
  overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
#bc .bar-track{flex:1;height:7px;border-radius:4px;background:#E9E0CE;overflow:hidden}
#bc .bar-fill{height:100%;border-radius:4px;background:#D6B45C;width:0;
  transition:width .5s cubic-bezier(.2,.8,.2,1)}
#bc .bar-row.self .bar-fill{background:#C0762A}
#bc .bar-row.self .who{color:#C0762A;font-weight:600}
#bc ul.commits{list-style:none;margin:0;padding:0}
#bc ul.commits li{padding:6px 0;border-top:1px solid #E9E0CE;font-size:12px;
  opacity:0;transform:translateY(4px);transition:opacity .35s ease,transform .35s ease}
#bc ul.commits li.in{opacity:1;transform:translateY(0)}
#bc ul.commits li:first-child{border-top:none}
#bc .sha{font:11px ui-monospace,monospace;color:#A5738C;margin-right:6px}
#bc .when{color:#8A94A3;font-size:11px}
#bc .subject{display:block;margin-top:1px;color:#35455C;overflow-wrap:anywhere}

#bc .age{margin:6px 0 0;font-size:11px;color:#8A94A3}
#bc .empty{color:#8A94A3;font-style:italic;padding:4px 0 2px}
#bc .close{position:absolute;top:10px;right:12px;border:none;background:none;
  color:#8A94A3;font-size:15px;cursor:pointer;padding:2px 6px;border-radius:5px}
#bc .close:hover{background:#E9E0CE;color:#35455C}

/* --- region strip: the lines this agent actually holds right now, not the
   whole file. Press R to flip against the ownership-bar view above. --- */
#bc .region-summary{margin:0 0 8px;font-size:12px;color:#35455C}
#bc .region-summary b{color:#C0762A}
#bc .region-gutter{display:flex;height:38px;border-radius:6px;overflow:hidden;
  background:#E9E0CE;box-shadow:inset 0 0 0 1px #C3B39B55}
#bc .region-seg{height:100%;width:0;transition:width .5s cubic-bezier(.2,.8,.2,1);
  position:relative}
#bc .region-seg.self{box-shadow:inset 0 0 0 2px #fffdfa99}
#bc .region-legend{display:flex;flex-wrap:wrap;gap:4px 10px;margin:8px 0 0}
#bc .region-note{margin:8px 0 0;font-size:10px;color:#8A94A3;font-style:italic}

/* --- single-owner collapse: one quiet sentence instead of a full-width
   bar that would just say "mohsensc 100%" --- */
#bc .solo-line{margin:0;font-size:12px;color:#35455C;display:flex;align-items:center;gap:6px}
#bc .solo-line b{color:#C0762A}
#bc .solo-line .swatch{width:9px;height:9px}

/* --- gutter variant: real source lines with a per-line author/age gutter,
   the closest this card gets to true line-by-line blame. Monospace,
   horizontally scrollable in its own box so a long line never pushes the
   whole panel wide. Text content only — real source is set via
   textContent, never innerHTML. --- */
#bc .code-gutter{border-radius:6px;background:#2B2320;overflow-x:auto;overflow-y:hidden;
  box-shadow:inset 0 0 0 1px #C3B39B55}
#bc .code-row{display:flex;align-items:stretch;white-space:pre;
  font:11px/1.6 ui-monospace,SFMono-Regular,Menlo,monospace}
#bc .code-mark{flex:none;width:4px}
#bc .code-n{flex:none;width:30px;text-align:right;padding-right:7px;color:#8A94A3;
  user-select:none}
#bc .code-text{flex:none;padding-right:14px;color:#F0ECE6}
#bc .gutter-legend{display:flex;flex-wrap:wrap;gap:4px 10px;margin:8px 0 0}

/* --- story variant: prose instead of bars, for the single-author-file
   common case where a bar would just be one solid color --- */
#bc .story-line{margin:0 0 8px;font-size:12.5px;line-height:1.55;color:#35455C;
  opacity:0;transform:translateY(3px);transition:opacity .35s ease,transform .35s ease}
#bc .story-line.in{opacity:1;transform:translateY(0)}
#bc .story-line:last-child{margin-bottom:0}

/* This card slides in on select, then several bits inside it (ownership
   bar, region strip, timeline dots, commit rows, story lines) transition
   in a second time, staggered a few dozen ms apart by staggerReveal()
   below. Same blanket "near-zero duration" pattern as office.html's #reel
   block and replay-card.js's — the stagger ITSELF is also skipped under
   reduced motion (see staggerReveal()), this just covers the transition
   that would otherwise still ease each element to its final state. */
@media (prefers-reduced-motion: reduce){
  #bc, #bc *{transition-duration:.01ms!important}
}
`

/** repo-relative path -> {blame, log} promise, so re-selecting the same agent
 *  within a session doesn't refetch. No TTL: this panel only lives while an
 *  agent is selected, not ambient like the hover tooltip's 30s cache. */
const cache = new Map()

function fetchJSON(fetchFn, url) {
  return fetchFn(url).then(r => r.json()).catch(() => ({ ok: false, reason: 'fetch failed' }))
}

function loadFor(path, fetchFn) {
  if (!path) return Promise.resolve({ blame: { ok: false }, log: { ok: false }, stat: { ok: false } })
  if (cache.has(path)) return cache.get(path)
  const p = Promise.all([
    fetchJSON(fetchFn, `/api/git/blame?path=${encodeURIComponent(path)}`),
    fetchJSON(fetchFn, `/api/git/log?path=${encodeURIComponent(path)}&n=8`),
    // only the story variant reads this, but it's one small round trip and
    // fetching it eagerly here means switching into story mid-session never
    // has to wait — same reasoning as blame/log already being prefetched
    // together for every variant
    fetchJSON(fetchFn, `/api/git/stat?path=${encodeURIComponent(path)}`),
  ]).then(([blame, log, stat]) => ({ blame, log, stat }))
  cache.set(path, p)
  return p
}

/** guarded the same way this file guards every other browser-only global
 *  (see the `location`/`addEventListener` checks elsewhere in office/*.js)
 *  so a non-browser test importing this module doesn't throw. */
function prefersReducedMotion() {
  return typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches
}

/** Reveal `apply(el)` across `list` staggered `delayFor(i)` ms apart — the
 *  shared shape behind every "grow the bar in" / "fade the row in" effect
 *  below. Under reduced motion the stagger itself goes away, not just the
 *  CSS easing (see the @media block in CSS above): every element jumps to
 *  its final state on the same tick instead of arriving one by one. */
function staggerReveal(list, delayFor, apply) {
  const reduced = prefersReducedMotion()
  list.forEach((el, i) => {
    if (reduced) { apply(el); return }
    setTimeout(() => apply(el), delayFor(i))
  })
}

/** path + line range -> ranged blame promise. Separate cache from loadFor's
 *  whole-file one — same path can be open in both modes at once (the R
 *  toggle swaps between them without refetching either). */
const regionCache = new Map()

function loadRegion(path, start, end, fetchFn) {
  if (!path) return Promise.resolve({ ok: false })
  const key = `${path}#${start}-${end}`
  if (regionCache.has(key)) return regionCache.get(key)
  const p = fetchJSON(fetchFn, `/api/git/blame?path=${encodeURIComponent(path)}&start=${start}&end=${end}`)
  regionCache.set(key, p)
  return p
}

/** path + line range -> {source, lineBlame} promise, for the gutter
 *  variant. Separate from regionCache: the region strip only ever needs
 *  the aggregate blame shape, the gutter needs the source route too and
 *  the `lines=1` per-line shape, so keeping them apart means asking for
 *  one doesn't force a fetch neither view needs. */
const gutterCache = new Map()

// Contract cap from gitapi.mjs's /api/git/source and blame's &lines=1: a
// range over 150 lines omits `lines` from blame, and source caps at 200.
// Don't even round-trip for a range we know the server will trim — same
// "no error, just degrade" rule as everything else in this file.
const GUTTER_LINE_CAP = 150

function loadGutter(path, start, end, fetchFn) {
  if (!path || !Number.isFinite(start) || !Number.isFinite(end)) return Promise.resolve(null)
  if (end - start > GUTTER_LINE_CAP) return Promise.resolve(null)
  const key = `${path}#${start}-${end}`
  if (gutterCache.has(key)) return gutterCache.get(key)
  const p = Promise.all([
    fetchJSON(fetchFn, `/api/git/source?path=${encodeURIComponent(path)}&start=${start}&end=${end}`),
    fetchJSON(fetchFn, `/api/git/blame?path=${encodeURIComponent(path)}&start=${start}&end=${end}&lines=1`),
  ]).then(([source, lineBlame]) => ({ source, lineBlame }))
  gutterCache.set(key, p)
  return p
}

function isSelf(agent, author) {
  return agent.role === author || agent.name === author
}

// ---------------------------------------------------------------------
// region blame — pure functions, covered directly by
// web/test/region-blame.test.ts without touching the DOM.
// ---------------------------------------------------------------------

/** Does this agent carry a real, well-formed line range? Absent/partial
 *  fields (today's whole-file agents, live frames with no region) both
 *  read as "no". Mirrors live.js's own regionFromMsg guard on the other
 *  end of the pipe: end must be strictly past start. */
export function hasUsableRegion(agent) {
  return !!agent && typeof agent.gitPath === 'string' && agent.gitPath.length > 0 &&
    Number.isFinite(agent.gitStart) && Number.isFinite(agent.gitEnd) &&
    agent.gitEnd > agent.gitStart
}

/** A ranged blame response is only "usable" if the endpoint actually found
 *  lines there. gitapi.mjs tolerates a bogus range (past EOF, etc.) by
 *  returning {ok:false} the same way it does for "no blame available" at
 *  all — this is the single point that decides whether the card falls back
 *  to the whole-file view or shows the region strip. */
export function regionBlameUsable(regionBlame) {
  return !!(regionBlame && regionBlame.ok && regionBlame.total > 0)
}

/** Ranged blame's `owners` array (same aggregate shape parseBlamePorcelain
 *  always returns — total lines + per-author share, not per-line text) into
 *  gutter segments: one per author, sorted biggest first, tagged `self` so
 *  the render step can outline the viewer's own share. */
export function regionGutterSegments(blame, agent) {
  if (!regionBlameUsable(blame)) return []
  return blame.owners.map(o => ({
    author: o.author,
    pct: Math.max(Math.round(o.share * 100), blame.owners.length > 1 ? 1.5 : Math.round(o.share * 100)),
    self: agent ? isSelf(agent, o.author) : false,
  }))
}

/** "these 14 lines: mostly mohsen (78%), newest 2 days ago" — the one-line
 *  summary that goes on top of the gutter. null when there's nothing
 *  usable to summarise (empty/absent region blame). */
export function regionSummary(blame) {
  if (!regionBlameUsable(blame)) return null
  const top = blame.owners[0]
  return {
    total: blame.total,
    topAuthor: top ? top.author : null,
    topPct: top ? Math.round(top.share * 100) : null,
    multiAuthor: blame.owners.length > 1,
    ageLabel: formatAge(blame.newestLineAgeDays),
  }
}

// ---------------------------------------------------------------------
// single-owner rendering — the demo repo's actual shape post email-dedup
// (see gitapi.mjs task 3): once mohsensc/Mohsen Sarrafan Chaharsoughi merge
// into one identity, most files here are 100% one author. A full-width
// gold bar and a one-row legend saying "mohsensc 100%" convey nothing —
// collapse to a sentence instead and hand the freed vertical space to the
// commit list.
// ---------------------------------------------------------------------

export function isSingleOwner(blame) {
  return !!(blame && blame.ok && Array.isArray(blame.owners) && blame.owners.length === 1 && blame.total > 0)
}

/** "all mohsensc, 210 lines, newest today" — collapsed sentence data for
 *  the single-owner case. null when there's more than one owner (or no
 *  usable blame at all), same shape-of-nullness as regionSummary. */
export function singleOwnerSummary(blame) {
  if (!isSingleOwner(blame)) return null
  const owner = blame.owners[0]
  return {
    author: owner.author,
    total: blame.total,
    ageLabel: formatAge(blame.newestLineAgeDays),
  }
}

// ---------------------------------------------------------------------
// gutter variant — real source lines from /api/git/source paired with the
// per-line author from blame's &lines=1 shape (gitapi.mjs, task 3's
// contract). Pure row-model builder: no DOM, so it's testable without a
// server. Returns null (not an empty array) whenever either side is
// missing/malformed/mismatched, which is the single signal the renderer
// needs to fall back to the proportional bar with no error — the server
// predating this contract, a >150-line range the server itself omitted
// `lines` for, or a plain fetch failure all collapse to the same null.
// ---------------------------------------------------------------------

export function buildGutterRows(sourceResp, lineBlameResp, opts = {}) {
  if (!sourceResp || sourceResp.ok !== true || !Array.isArray(sourceResp.lines)) return null
  if (!lineBlameResp || lineBlameResp.ok !== true || !Array.isArray(lineBlameResp.lines)) return null
  if (sourceResp.lines.length === 0) return null
  const startLine = Number.isFinite(opts.startLine) ? opts.startLine : 1
  const byLine = new Map(lineBlameResp.lines.map((l) => [l.n, l]))
  const knownAges = lineBlameResp.lines.map((l) => l.ageDays).filter((d) => typeof d === 'number')
  const maxAge = knownAges.length ? Math.max(...knownAges, 1) : 1
  return sourceResp.lines.map((text, i) => {
    const n = startLine + i
    const b = byLine.get(n)
    const age = b && typeof b.ageDays === 'number' ? b.ageDays : null
    return {
      n,
      text: String(text),
      author: (b && b.author) || null,
      // fresher lines read stronger, older lines fade toward the gutter
      // background instead of disappearing entirely
      opacity: age == null ? 0.3 : Math.max(0.28, 1 - Math.min(1, age / maxAge) * 0.68),
    }
  })
}

// ---------------------------------------------------------------------
// graphic variant
// ---------------------------------------------------------------------

function renderOwnershipGraphic(host, blame, agent) {
  if (!blame || !blame.ok || !blame.total) {
    host.innerHTML = '<p class="empty">no history here yet</p>'
    return
  }
  const owners = blame.owners.map(o => ({ ...o, self: isSelf(agent, o.author) }))
  const track = document.createElement('div')
  track.className = 'tug-track'
  const legend = document.createElement('div')
  legend.className = 'tug-legend'
  owners.forEach(o => {
    const pct = Math.round(o.share * 100)
    const color = colorForAuthor(o.author)
    const seg = document.createElement('span')
    seg.className = 'tug-seg' + (o.self ? ' self' : '')
    seg.style.background = color
    seg.dataset.target = String(Math.max(pct, owners.length > 1 ? 1.5 : pct))
    track.appendChild(seg)

    const who = document.createElement('span')
    who.className = 'who' + (o.self ? ' self' : '')
    who.innerHTML = `<span class="swatch" style="background:${color}"></span>${o.author}<span class="pct">${pct}%</span>`
    legend.appendChild(who)
  })
  host.innerHTML = ''
  host.appendChild(track)
  host.appendChild(legend)
  if (blame.newestLineAgeDays != null && blame.oldestLineAgeDays != null) {
    const age = document.createElement('p')
    age.className = 'age'
    age.textContent = `newest line ${blame.newestLineAgeDays}d old · oldest line ${blame.oldestLineAgeDays}d old`
    host.appendChild(age)
  }
  // Grow the segments in on the next frame so the 0->N width transition
  // actually plays instead of the browser coalescing it with the initial
  // 0% paint. Staggered slightly per segment, biggest owner leads.
  requestAnimationFrame(() => {
    staggerReveal(track.querySelectorAll('.tug-seg'), i => i * 70,
      seg => { seg.style.width = seg.dataset.target + '%' })
  })
}

function renderHistoryGraphic(host, log) {
  if (!log || !log.ok || !log.entries || !log.entries.length) {
    host.innerHTML = '<p class="empty">no history here yet</p>'
    return
  }
  const entries = log.entries.map(e => ({ ...e, ageDays: parseRelativeAge(e.when) }))
  const known = entries.map(e => e.ageDays).filter(d => d != null)
  const maxDays = known.length ? Math.max(...known) : 1
  // ages fed straight to stackTimelinePositions in the same order as
  // entries, so out[i] lines up with entries[i]
  const ages = entries.map(e => e.ageDays == null ? 0.5 : e.ageDays)
  const slots = stackTimelinePositions(ages, maxDays)

  const wrap = document.createElement('div')
  wrap.className = 'timeline'
  const track = document.createElement('div')
  track.className = 'timeline-track'
  wrap.appendChild(track)
  const tip = document.createElement('div')
  tip.className = 'timeline-tip'
  wrap.appendChild(tip)

  entries.forEach((e, i) => {
    const { x, bucketSize, bucketPos } = slots[i]
    const dot = document.createElement('div')
    dot.className = 'timeline-dot'
    dot.tabIndex = 0
    dot.style.left = `${(x * 100).toFixed(1)}%`
    // collisions stack upward off the axis rather than piling on one pixel
    dot.style.top = `${30 - Math.min(bucketPos, 5) * 6}px`
    dot.style.background = colorForAuthor(e.author)
    const showTip = () => {
      const countTip = bucketSize > 1 ? ` <span class="who2">(1 of ${bucketSize} near this age)</span>` : ''
      tip.innerHTML = `<b>${e.subject || '(no subject)'}</b>${countTip}<span class="who2">${e.author || ''} · ${e.when || ''}</span>`
      tip.style.left = dot.style.left
      tip.classList.add('on')
    }
    const hideTip = () => tip.classList.remove('on')
    dot.addEventListener('mouseenter', showTip)
    dot.addEventListener('focus', showTip)
    dot.addEventListener('mouseleave', hideTip)
    dot.addEventListener('blur', hideTip)
    // badge the last dot placed in a bucket (paints on top of its siblings)
    // with the collision count instead of silently rendering 8 commits as 1
    if (bucketSize > 1 && bucketPos === bucketSize - 1) {
      const badge = document.createElement('span')
      badge.className = 'timeline-badge'
      badge.textContent = `×${bucketSize}`
      dot.appendChild(badge)
    }
    wrap.appendChild(dot)
    // Built and staggered inline per-dot rather than through
    // staggerReveal() above — that helper wants an already-built list to
    // reveal in a second pass; this loop builds each dot AND schedules its
    // own reveal in the same iteration, so the reduced-motion check is
    // just inlined here instead.
    if (prefersReducedMotion()) dot.classList.add('in')
    else setTimeout(() => dot.classList.add('in'), 120 + i * 55)
  })

  const axis = document.createElement('div')
  axis.className = 'timeline-axis'
  axis.innerHTML = `<span>oldest</span><span>newest</span>`

  host.innerHTML = ''
  host.appendChild(wrap)
  host.appendChild(axis)
}

// ---------------------------------------------------------------------
// region strip: the lines the agent actually holds, not the whole file.
// Built on the same `owners` aggregate parseBlamePorcelain always returns
// (no per-line text or per-line author sequence comes back from the
// endpoint today — see gitapi.mjs's blame route), so the gutter is
// proportional colour, not a literal line-by-line render. Good enough to
// answer "whose lines are these, and how fresh" at a glance; true
// line-by-line rendering would need the porcelain parser to keep per-line
// author instead of collapsing straight to totals, which is a gitapi.mjs
// change and out of scope for the file-ownership boundary this round drew.
// ---------------------------------------------------------------------

function renderRegionStrip(host, regionBlame, agent, range) {
  const summary = regionSummary(regionBlame)
  if (!summary) {
    host.innerHTML = '<p class="empty">no blame for this range</p>'
    return
  }
  const segs = regionGutterSegments(regionBlame, agent)

  const p = document.createElement('p')
  p.className = 'region-summary'
  const who = summary.multiAuthor ? `mostly <b>${summary.topAuthor}</b> (${summary.topPct}%)` : `<b>${summary.topAuthor}</b>`
  const age = summary.ageLabel ? `, newest ${agePhrase(summary.ageLabel, 'old')}` : ''
  p.innerHTML = `these ${summary.total} lines: ${who}${age}`

  const track = document.createElement('div')
  track.className = 'region-gutter'
  const legend = document.createElement('div')
  legend.className = 'region-legend'
  segs.forEach(s => {
    const color = colorForAuthor(s.author)
    const seg = document.createElement('span')
    seg.className = 'region-seg' + (s.self ? ' self' : '')
    seg.style.background = color
    seg.dataset.target = String(s.pct)
    track.appendChild(seg)

    const who2 = document.createElement('span')
    who2.className = 'who' + (s.self ? ' self' : '')
    who2.innerHTML = `<span class="swatch" style="background:${color}"></span>${s.author}<span class="pct">${Math.round(s.pct)}%</span>`
    legend.appendChild(who2)
  })

  const note = document.createElement('p')
  note.className = 'region-note'
  note.textContent = range ? `lines ${range.start}–${range.end}, held right now` : 'held right now'

  host.innerHTML = ''
  host.appendChild(p)
  host.appendChild(track)
  host.appendChild(legend)
  host.appendChild(note)

  requestAnimationFrame(() => {
    staggerReveal(track.querySelectorAll('.region-seg'), i => i * 70,
      seg => { seg.style.width = seg.dataset.target + '%' })
  })
}

/** Single-owner collapse: no bar, no legend, one sentence. Used by the
 *  graphic variant in place of renderOwnershipGraphic whenever
 *  isSingleOwner(blame) is true — a full-width bar with one legend row
 *  saying "mohsensc 100%" conveys nothing a sentence doesn't say faster. */
function renderOwnershipSingle(host, blame) {
  const s = singleOwnerSummary(blame)
  if (!s) { host.innerHTML = '<p class="empty">no history here yet</p>'; return }
  const age = s.ageLabel ? `, newest ${agePhrase(s.ageLabel, 'old')}` : ''
  const p = document.createElement('p')
  p.className = 'solo-line'
  p.innerHTML = `<span class="swatch" style="background:${colorForAuthor(s.author)}"></span>` +
    `all <b>${s.author}</b> — ${s.total} lines, all theirs${age}`
  host.innerHTML = ''
  host.appendChild(p)
}

// ---------------------------------------------------------------------
// gutter variant: real source + real per-line blame, rendered as an
// editor-style gutter. Rows come from buildGutterRows; this is the DOM
// half. Every line of source is set with textContent, never innerHTML —
// it's real code from the repo going on screen, not markup this file wrote.
// ---------------------------------------------------------------------

function renderGutter(host, rows) {
  const wrap = document.createElement('div')
  wrap.className = 'code-gutter'
  const authors = new Map()
  rows.forEach(r => {
    const row = document.createElement('div')
    row.className = 'code-row'

    const mark = document.createElement('span')
    mark.className = 'code-mark'
    if (r.author) {
      mark.style.background = colorForAuthor(r.author)
      mark.style.opacity = String(r.opacity)
      mark.title = r.author
      if (!authors.has(r.author)) authors.set(r.author, colorForAuthor(r.author))
    }

    const n = document.createElement('span')
    n.className = 'code-n'
    n.textContent = String(r.n)

    const code = document.createElement('span')
    code.className = 'code-text'
    code.textContent = r.text   // never innerHTML: this is real source

    row.appendChild(mark)
    row.appendChild(n)
    row.appendChild(code)
    wrap.appendChild(row)
  })

  const legend = document.createElement('div')
  legend.className = 'gutter-legend'
  authors.forEach((color, author) => {
    const who = document.createElement('span')
    who.className = 'who'
    who.innerHTML = `<span class="swatch" style="background:${color}"></span>${author}`
    legend.appendChild(who)
  })

  host.innerHTML = ''
  host.appendChild(wrap)
  host.appendChild(legend)
}

/** Ownership slot for the gutter variant: real per-line rows when the
 *  server has the &lines=1 / /api/git/source contract and the range fetched
 *  clean, otherwise fall straight back to whatever the non-gutter view
 *  would have shown — region strip, single-owner sentence, or the
 *  proportional bar — with no error state in between. */
function renderGutterSection(host, current, agent) {
  if (current.gutterRows && current.gutterRows.length) {
    renderGutter(host, current.gutterRows)
    return
  }
  if (current.hasRegion) {
    renderRegionStrip(host, current.regionData, agent, current.range)
  } else if (isSingleOwner(current.data.blame)) {
    renderOwnershipSingle(host, current.data.blame)
  } else {
    renderOwnershipGraphic(host, current.data.blame, agent)
  }
  const note = document.createElement('p')
  note.className = 'region-note'
  note.textContent = current.wantedGutter
    ? 'line-by-line detail unavailable for this range — showing proportional view'
    : 'select an agent holding a line range to see line-by-line detail'
  host.appendChild(note)
}

// ---------------------------------------------------------------------
// classic variant (the earlier per-row/list treatment, kept for comparison)
// ---------------------------------------------------------------------

function renderOwnershipClassic(host, blame, agent) {
  if (!blame || !blame.ok || !blame.total) {
    host.innerHTML = '<p class="empty">no history here yet</p>'
    return
  }
  const owners = blame.owners.map(o => ({ ...o, self: isSelf(agent, o.author) }))
  host.innerHTML = owners.map(o => {
    const pct = Math.round(o.share * 100)
    return `<div class="bar-row${o.self ? ' self' : ''}">
      <span class="who" title="${o.author}">${o.author}</span>
      <span class="bar-track"><span class="bar-fill" data-target="${Math.max(pct, 2)}"></span></span>
      <span class="pct">${pct}%</span>
    </div>`
  }).join('') + (blame.newestLineAgeDays != null
    ? `<p class="age">newest line ${blame.newestLineAgeDays}d old · oldest line ${blame.oldestLineAgeDays}d old</p>`
    : '')
  requestAnimationFrame(() => {
    staggerReveal(host.querySelectorAll('.bar-fill'), i => i * 60,
      el => { el.style.width = el.dataset.target + '%' })
  })
}

function renderHistoryClassic(host, log) {
  if (!log || !log.ok || !log.entries || !log.entries.length) {
    host.innerHTML = '<p class="empty">no history here yet</p>'
    return
  }
  const ul = document.createElement('ul')
  ul.className = 'commits'
  ul.innerHTML = log.entries.map(e => {
    const sha = (e.sha || '').slice(0, 7)
    return `<li><span class="sha">${sha}</span><span class="when">${e.when || ''}</span>
      <span class="subject">${e.subject || ''} — <em>${e.author || ''}</em></span></li>`
  }).join('')
  host.innerHTML = ''
  host.appendChild(ul)
  requestAnimationFrame(() => {
    staggerReveal(ul.querySelectorAll('li'), i => i * 45, li => li.classList.add('in'))
  })
}

// ---------------------------------------------------------------------
// story variant: prose composed from stat/log/blame (composeStory,
// history-viz.js) instead of a bar. Special-cased in renderBody like
// gutter — it needs the whole {blame, log, stat} triple, not just the
// aggregate blame object the graphic/classic ownership fns take — so
// .ownership below is unused, kept only so Object.keys(VARIANTS) still
// drives the V cycle and picks up the right label.
// ---------------------------------------------------------------------

function renderStorySection(host, data) {
  const { lines } = composeStory(data.stat, data.log, data.blame)
  host.innerHTML = ''
  lines.forEach((line, i) => {
    const p = document.createElement('p')
    p.className = 'story-line'
    p.textContent = line
    host.appendChild(p)
    if (prefersReducedMotion()) p.classList.add('in')
    else setTimeout(() => p.classList.add('in'), 60 + i * 90)
  })
}

const VARIANTS = {
  graphic: { ownership: renderOwnershipGraphic, history: renderHistoryGraphic, label: 'graphic' },
  classic: { ownership: renderOwnershipClassic, history: renderHistoryClassic, label: 'classic' },
  // gutter's ownership slot is special-cased in renderBody (it needs the
  // fetched source/line-blame pair, not just the aggregate blame object
  // the other two variants' ownership fns take) — .ownership here is
  // unused but kept so Object.keys(VARIANTS) still drives the V cycle.
  gutter: { ownership: null, history: renderHistoryClassic, label: 'gutter' },
  story: { ownership: null, history: renderHistoryClassic, label: 'story' },
}

/** Whether a file's deduped blame owner count means the ownership bar
 *  would just be one solid color — the case story exists for. Exported so
 *  the single-owner auto-pick logic and its tests share one definition
 *  of "dead bar" with isSingleOwner instead of restating the check. */
export function pickDefaultVariant(blame) {
  return isSingleOwner(blame) ? 'story' : 'graphic'
}

function initialVariant() {
  try {
    const q = new URLSearchParams(location.search).get('bcVariant')
    if (q && VARIANTS[q]) return { variant: q, explicit: true }
  } catch { /* no location in a non-browser test context */ }
  return { variant: 'graphic', explicit: false }
}

/**
 * attachBlameCard({ world, fetchFn }) -> { show(agent), hide(), setVariant(name) }
 *
 * Pure DOM controller — no camera logic here. office.html wires it through
 * the interact.js onSelect hook (once that lands) and, until then, straight
 * off window.__zoomAgent so the whole flow is drivable from the console.
 */
export function attachBlameCard(cfg = {}) {
  const { fetchFn = (...a) => fetch(...a) } = cfg

  const style = document.createElement('style')
  style.textContent = CSS
  document.head.appendChild(style)

  const el = document.createElement('div')
  el.id = 'bc'
  el.innerHTML = `
    <button class="close" title="close">×</button>
    <h2 id="bcName">—</h2>
    <p class="human" id="bcHuman">—</p>
    <p class="path" id="bcPath">—</p>
    <div id="bcBody"></div>
  `
  document.body.appendChild(el)
  el.querySelector('.close').addEventListener('click', () => cfg.onClose?.())

  let reqId = 0
  const initVariant = initialVariant()
  let variant = initVariant.variant
  // once true (an explicit ?bcVariant=, a V press, or the button click),
  // the single-owner auto-pick in show() below leaves `variant` alone —
  // the owner's own choice always wins over "this file happens to be
  // single-author"
  let variantPinned = initVariant.explicit
  let current = null // { agent, data } — so a variant switch can re-render without refetching

  function renderBody() {
    if (!current) return
    const { agent, data } = current
    const body = el.querySelector('#bcBody')
    body.innerHTML = ''

    const isGutter = variant === 'gutter'
    const isStory = variant === 'story'
    const showRegion = !isGutter && !isStory && current.hasRegion && current.regionMode
    const showRange = isGutter ? !!current.range : showRegion
    el.querySelector('#bcPath').textContent = showRange
      ? `${agent.gitPath} : lines ${current.range.start}–${current.range.end}`
      : (agent.gitPath || 'no file tracked yet')

    const ownH3 = document.createElement('h3')
    // the region/whole-file toggle only makes sense outside gutter mode —
    // gutter always shows whatever range the agent holds (or a fallback
    // note explaining why it can't)
    const toggleBtn = (current.hasRegion && !isGutter && !isStory)
      ? `<button class="variant-btn" id="bcRegionBtn" title="press R to switch between region and whole file">${showRegion ? 'this region' : 'whole file'}</button>`
      : ''
    ownH3.innerHTML = `<span>whose lines these are</span>` +
      toggleBtn +
      `<button class="variant-btn" id="bcVariantBtn" title="press V to switch view">${VARIANTS[variant].label}</button>`
    if (current.hasRegion && !isGutter && !isStory) ownH3.querySelector('#bcRegionBtn').addEventListener('click', () => toggleRegion())
    ownH3.querySelector('#bcVariantBtn').addEventListener('click', () => cycleVariant())
    body.appendChild(ownH3)
    const ownBody = document.createElement('div')
    body.appendChild(ownBody)
    if (isGutter) {
      renderGutterSection(ownBody, current, agent)
    } else if (isStory) {
      renderStorySection(ownBody, data)
    } else if (showRegion) {
      renderRegionStrip(ownBody, current.regionData, agent, current.range)
    } else if (variant === 'graphic' && isSingleOwner(data.blame)) {
      renderOwnershipSingle(ownBody, data.blame)
    } else {
      VARIANTS[variant].ownership(ownBody, data.blame, agent)
    }

    const histH3 = document.createElement('h3')
    histH3.textContent = 'recent commits'
    body.appendChild(histH3)
    const histBody = document.createElement('div')
    body.appendChild(histBody)
    // single-owner reclaims the vertical space the collapsed sentence
    // freed up by using the classic commit list instead of the dot
    // timeline; gutter and story are both code/text-focused throughout so
    // they get the list too
    const useListHistory = isGutter || isStory || (variant === 'graphic' && isSingleOwner(data.blame))
    ;(useListHistory ? renderHistoryClassic : VARIANTS[variant].history)(histBody, data.log)
  }

  function cycleVariant() {
    const names = Object.keys(VARIANTS)
    variant = names[(names.indexOf(variant) + 1) % names.length]
    variantPinned = true
    renderBody()
  }

  function toggleRegion() {
    if (!current || !current.hasRegion || variant === 'gutter' || variant === 'story') return
    current.regionMode = !current.regionMode
    renderBody()
  }

  function onKeydown(e) {
    if (!el.classList.contains('on')) return
    const tag = (document.activeElement && document.activeElement.tagName) || ''
    if (tag === 'INPUT' || tag === 'TEXTAREA') return
    if (e.key === 'v' || e.key === 'V') return cycleVariant()
    if (e.key === 'r' || e.key === 'R') return toggleRegion()
  }
  addEventListener('keydown', onKeydown)

  function show(agent) {
    if (!agent) return hide()
    el.querySelector('#bcName').textContent = agent.name
    el.querySelector('#bcHuman').textContent = agent.role || 'agent'
    el.querySelector('#bcPath').textContent = agent.gitPath || 'no file tracked yet'
    el.classList.add('on')

    const path = agent.gitPath
    const wantsRegion = hasUsableRegion(agent)
    const myReq = ++reqId
    current = null
    el.querySelector('#bcBody').innerHTML =
      path ? '<p class="empty">loading…</p>' : '<p class="empty">no history here yet</p>'
    if (!path) return
    // gutter data is only worth fetching when there's a real region to ask
    // for — no point round-tripping /api/git/source for a whole-file agent
    Promise.all([
      loadFor(path, fetchFn),
      wantsRegion ? loadRegion(path, agent.gitStart, agent.gitEnd, fetchFn) : Promise.resolve(null),
      wantsRegion ? loadGutter(path, agent.gitStart, agent.gitEnd, fetchFn) : Promise.resolve(null),
    ]).then(([data, regionBlame, gutter]) => {
      if (myReq !== reqId) return   // a later select() beat this fetch home
      // single-owner auto-pick: unless the owner has already made an
      // explicit choice this session (?bcVariant=, a V press, or the
      // button), a single-author file opens on story instead of graphic —
      // see pickDefaultVariant's comment for why. Explicit choices always
      // win, and this only ever moves *toward* story, never away from a
      // variant the owner picked on purpose.
      if (!variantPinned) variant = pickDefaultVariant(data.blame)
      const hasRegion = wantsRegion && regionBlameUsable(regionBlame)
      const gutterRows = gutter
        ? buildGutterRows(gutter.source, gutter.lineBlame, { startLine: agent.gitStart })
        : null
      const hasKnownRange = hasRegion || !!(gutterRows && gutterRows.length)
      current = {
        agent, data, regionData: regionBlame, hasRegion,
        regionMode: hasRegion,   // default to the region view when there is one — it's the more specific answer
        range: hasKnownRange ? { start: agent.gitStart, end: agent.gitEnd } : null,
        gutterRows,
        wantedGutter: wantsRegion,
      }
      renderBody()
    })
  }

  function hide() {
    el.classList.remove('on')
    reqId++   // orphan any in-flight fetch for the agent we just left
    current = null
  }

  return { show, hide, setVariant: (v) => { if (VARIANTS[v]) { variant = v; variantPinned = true; renderBody() } }, el }
}
