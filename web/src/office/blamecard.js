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
// Two switchable card layouts (press V while a card is open, or load with
// ?bcVariant=classic): "graphic" (default) draws ownership as one tug-of-war
// bar and history as a dot timeline; "classic" is the earlier per-author-row
// + text-list treatment, kept around so the two can be compared side by
// side rather than thrown away. See STATE.md round-2-task-3 for which one
// the owner picked, if they picked.

import { colorForAuthor, parseRelativeAge, ageToX } from './history-viz.js'

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
#bc .timeline{position:relative;height:34px;margin:2px 4px 0}
#bc .timeline-track{position:absolute;left:0;right:0;top:16px;height:2px;background:#E9E0CE}
#bc .timeline-axis{display:flex;justify-content:space-between;font:9px ui-sans-serif,sans-serif;
  color:#8A94A3;margin:2px 2px 0}
#bc .timeline-dot{position:absolute;top:8px;width:10px;height:10px;margin-left:-5px;
  border-radius:50%;border:2px solid #fffdfa;cursor:pointer;transform:scale(0);opacity:0;
  transition:transform .4s cubic-bezier(.34,1.56,.64,1), opacity .3s ease;
  box-shadow:0 1px 3px #4a1f3d33}
#bc .timeline-dot.in{transform:scale(1);opacity:1}
#bc .timeline-dot:hover,#bc .timeline-dot:focus{transform:scale(1.35)}
#bc .timeline-tip{position:absolute;bottom:100%;left:50%;transform:translate(-50%,-6px);
  background:#35455C;color:#F0ECE6;padding:6px 8px;border-radius:6px;font-size:11px;
  white-space:nowrap;pointer-events:none;opacity:0;transition:opacity .15s ease;z-index:2}
#bc .timeline-tip.on{opacity:1}
#bc .timeline-tip b{display:block;font-size:11px}
#bc .timeline-tip .who2{opacity:.75}

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
`

/** repo-relative path -> {blame, log} promise, so re-selecting the same agent
 *  within a session doesn't refetch. No TTL: this panel only lives while an
 *  agent is selected, not ambient like the hover tooltip's 30s cache. */
const cache = new Map()

function fetchJSON(fetchFn, url) {
  return fetchFn(url).then(r => r.json()).catch(() => ({ ok: false, reason: 'fetch failed' }))
}

function loadFor(path, fetchFn) {
  if (!path) return Promise.resolve({ blame: { ok: false }, log: { ok: false } })
  if (cache.has(path)) return cache.get(path)
  const p = Promise.all([
    fetchJSON(fetchFn, `/api/git/blame?path=${encodeURIComponent(path)}`),
    fetchJSON(fetchFn, `/api/git/log?path=${encodeURIComponent(path)}&n=8`),
  ]).then(([blame, log]) => ({ blame, log }))
  cache.set(path, p)
  return p
}

function isSelf(agent, author) {
  return agent.role === author || agent.name === author
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
    track.querySelectorAll('.tug-seg').forEach((seg, i) => {
      setTimeout(() => { seg.style.width = seg.dataset.target + '%' }, i * 70)
    })
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

  const wrap = document.createElement('div')
  wrap.className = 'timeline'
  const track = document.createElement('div')
  track.className = 'timeline-track'
  wrap.appendChild(track)
  const tip = document.createElement('div')
  tip.className = 'timeline-tip'
  wrap.appendChild(tip)

  entries.forEach((e, i) => {
    const d = e.ageDays == null ? 0.5 : e.ageDays
    const x = ageToX(d, maxDays)
    const dot = document.createElement('div')
    dot.className = 'timeline-dot'
    dot.tabIndex = 0
    dot.style.left = `${(x * 100).toFixed(1)}%`
    dot.style.background = colorForAuthor(e.author)
    const showTip = () => {
      tip.innerHTML = `<b>${e.subject || '(no subject)'}</b><span class="who2">${e.author || ''} · ${e.when || ''}</span>`
      tip.style.left = dot.style.left
      tip.classList.add('on')
    }
    const hideTip = () => tip.classList.remove('on')
    dot.addEventListener('mouseenter', showTip)
    dot.addEventListener('focus', showTip)
    dot.addEventListener('mouseleave', hideTip)
    dot.addEventListener('blur', hideTip)
    wrap.appendChild(dot)
    setTimeout(() => dot.classList.add('in'), 120 + i * 55)
  })

  const axis = document.createElement('div')
  axis.className = 'timeline-axis'
  axis.innerHTML = `<span>oldest</span><span>newest</span>`

  host.innerHTML = ''
  host.appendChild(wrap)
  host.appendChild(axis)
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
    host.querySelectorAll('.bar-fill').forEach((el, i) => {
      setTimeout(() => { el.style.width = el.dataset.target + '%' }, i * 60)
    })
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
    ul.querySelectorAll('li').forEach((li, i) => setTimeout(() => li.classList.add('in'), i * 45))
  })
}

const VARIANTS = {
  graphic: { ownership: renderOwnershipGraphic, history: renderHistoryGraphic, label: 'graphic' },
  classic: { ownership: renderOwnershipClassic, history: renderHistoryClassic, label: 'classic' },
}

function initialVariant() {
  try {
    const q = new URLSearchParams(location.search).get('bcVariant')
    if (q && VARIANTS[q]) return q
  } catch { /* no location in a non-browser test context */ }
  return 'graphic'
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
  let variant = initialVariant()
  let current = null // { agent, data } — so a variant switch can re-render without refetching

  function renderBody() {
    if (!current) return
    const { agent, data } = current
    const body = el.querySelector('#bcBody')
    body.innerHTML = ''

    const ownH3 = document.createElement('h3')
    ownH3.innerHTML = `<span>whose lines these are</span>` +
      `<button class="variant-btn" title="press V to switch view">${VARIANTS[variant].label}</button>`
    ownH3.querySelector('.variant-btn').addEventListener('click', () => cycleVariant())
    body.appendChild(ownH3)
    const ownBody = document.createElement('div')
    body.appendChild(ownBody)
    VARIANTS[variant].ownership(ownBody, data.blame, agent)

    const histH3 = document.createElement('h3')
    histH3.textContent = 'recent commits'
    body.appendChild(histH3)
    const histBody = document.createElement('div')
    body.appendChild(histBody)
    VARIANTS[variant].history(histBody, data.log)
  }

  function cycleVariant() {
    const names = Object.keys(VARIANTS)
    variant = names[(names.indexOf(variant) + 1) % names.length]
    renderBody()
  }

  function onKeydown(e) {
    if (e.key !== 'v' && e.key !== 'V') return
    if (!el.classList.contains('on')) return
    const tag = (document.activeElement && document.activeElement.tagName) || ''
    if (tag === 'INPUT' || tag === 'TEXTAREA') return
    cycleVariant()
  }
  addEventListener('keydown', onKeydown)

  function show(agent) {
    if (!agent) return hide()
    el.querySelector('#bcName').textContent = agent.name
    el.querySelector('#bcHuman').textContent = agent.role || 'agent'
    el.querySelector('#bcPath').textContent = agent.gitPath || 'no file tracked yet'
    el.classList.add('on')

    const path = agent.gitPath
    const myReq = ++reqId
    current = null
    el.querySelector('#bcBody').innerHTML =
      path ? '<p class="empty">loading…</p>' : '<p class="empty">no history here yet</p>'
    if (!path) return
    loadFor(path, fetchFn).then(data => {
      if (myReq !== reqId) return   // a later select() beat this fetch home
      current = { agent, data }
      renderBody()
    })
  }

  function hide() {
    el.classList.remove('on')
    reqId++   // orphan any in-flight fetch for the agent we just left
    current = null
  }

  return { show, hide, setVariant: (v) => { if (VARIANTS[v]) { variant = v; renderBody() } }, el }
}
