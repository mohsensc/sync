// Blame card: the DOM overlay that slides in when the camera zooms into an
// agent's head. Same pattern as interact.js's #ip/#it — its own injected
// <style>, its own div, nothing added to office.html's markup.
//
// Data comes from the git-data dev endpoints (see gitapi.mjs, built
// concurrently this round): /api/git/blame and /api/git/log. Both are being
// written against this file's expectations at the same time, so every fetch
// is defensive — {ok:false}, a network error, or the endpoint simply not
// existing yet all fall through to the same "no history here yet" state.
// Never an empty box.

const CSS = `
#bc{position:fixed;left:18px;top:50%;transform:translate(-16px,-50%);
  width:280px;max-height:72vh;overflow-y:auto;background:#fffdfaf2;
  border:1px solid #C3B39B;border-radius:12px;padding:16px 18px;
  box-shadow:0 14px 40px #4a1f3d26;opacity:0;pointer-events:none;
  transition:opacity .38s ease, transform .38s cubic-bezier(.2,.8,.3,1.1);
  z-index:8;font:13px/1.5 ui-sans-serif,-apple-system,Segoe UI,sans-serif;color:#35455C}
#bc.on{opacity:1;pointer-events:auto;transform:translate(0,-50%)}
#bc h2{font-size:16px;margin:0 0 1px;letter-spacing:-.01em}
#bc .human{font-size:12px;color:#A5738C;margin:0 0 2px}
#bc .path{font:11px ui-monospace,monospace;color:#8A94A3;margin:0 0 12px;
  overflow-wrap:anywhere}
#bc h3{font-size:10px;text-transform:uppercase;letter-spacing:.06em;
  color:#8A94A3;margin:14px 0 7px}
#bc h3:first-of-type{margin-top:2px}
#bc .bar-row{display:flex;align-items:center;gap:7px;margin:0 0 6px}
#bc .bar-row .who{width:78px;flex:0 0 78px;font-size:11px;color:#35455C;
  overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
#bc .bar-track{flex:1;height:7px;border-radius:4px;background:#E9E0CE;overflow:hidden}
#bc .bar-fill{height:100%;border-radius:4px;background:#D6B45C}
#bc .bar-row.self .bar-fill{background:#C0762A}
#bc .bar-row.self .who{color:#C0762A;font-weight:600}
#bc .pct{width:32px;flex:0 0 32px;text-align:right;font:11px ui-monospace,monospace;
  color:#8A94A3}
#bc .age{margin:6px 0 0;font-size:11px;color:#8A94A3}
#bc ul{list-style:none;margin:0;padding:0}
#bc li{padding:6px 0;border-top:1px solid #E9E0CE;font-size:12px}
#bc li:first-child{border-top:none}
#bc .sha{font:11px ui-monospace,monospace;color:#A5738C;margin-right:6px}
#bc .when{color:#8A94A3;font-size:11px}
#bc .subject{display:block;margin-top:1px;color:#35455C;overflow-wrap:anywhere}
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

function bar(owner, total) {
  const pct = Math.round((owner.share ?? (owner.lines / total)) * 100)
  const self = owner.self ? ' self' : ''
  return `<div class="bar-row${self}">
    <span class="who" title="${owner.author}">${owner.author}</span>
    <span class="bar-track"><span class="bar-fill" style="width:${Math.max(pct, 2)}%"></span></span>
    <span class="pct">${pct}%</span>
  </div>`
}

function commitRow(e) {
  const sha = (e.sha || '').slice(0, 7)
  return `<li><span class="sha">${sha}</span><span class="when">${e.when || ''}</span>
    <span class="subject">${e.subject || ''} — <em>${e.author || ''}</em></span></li>`
}

/**
 * attachBlameCard({ world, fetchFn }) -> { show(agent), hide() }
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

  function renderBody(agent, data) {
    const body = el.querySelector('#bcBody')
    const { blame, log } = data
    let html = ''

    html += '<h3>whose lines these are</h3>'
    if (blame && blame.ok && blame.total > 0) {
      const owners = blame.owners.map(o => ({
        ...o, self: agent.role === o.author || agent.name === o.author,
      }))
      html += owners.map(o => bar(o, blame.total)).join('')
      const newest = blame.newestLineAgeDays, oldest = blame.oldestLineAgeDays
      if (newest != null && oldest != null) {
        html += `<p class="age">newest line ${newest}d old · oldest line ${oldest}d old</p>`
      }
    } else {
      html += '<p class="empty">no history here yet</p>'
    }

    html += '<h3>recent commits</h3>'
    if (log && log.ok && log.entries && log.entries.length) {
      html += `<ul>${log.entries.map(commitRow).join('')}</ul>`
    } else {
      html += '<p class="empty">no history here yet</p>'
    }

    body.innerHTML = html
  }

  function show(agent) {
    if (!agent) return hide()
    el.querySelector('#bcName').textContent = agent.name
    el.querySelector('#bcHuman').textContent = agent.role || 'agent'
    el.querySelector('#bcPath').textContent = agent.gitPath || 'no file tracked yet'
    el.classList.add('on')

    const path = agent.gitPath
    const myReq = ++reqId
    el.querySelector('#bcBody').innerHTML =
      path ? '<p class="empty">loading…</p>' : '<p class="empty">no history here yet</p>'
    if (!path) return
    loadFor(path, fetchFn).then(data => {
      if (myReq !== reqId) return   // a later select() beat this fetch home
      renderBody(agent, data)
    })
  }

  function hide() {
    el.classList.remove('on')
    reqId++   // orphan any in-flight fetch for the agent we just left
  }

  return { show, hide, el }
}
