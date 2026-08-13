// The highlight reel: every clash between agents, ranked by rung, newest
// first. Two layers, same split as live.js — pure logic, then a thin DOM
// layer that draws it.
//
// ReelStore holds events and answers filtered/sorted views. It has no idea
// what a <div> is, so it's unit tested the same way LiveDirector is (see
// test/office-reel.test.ts) — plain describe/it, no DOM.
//
// mountReel() takes a container element and a store and draws rows into it.
// It re-renders on filter clicks and whenever the caller calls render()
// after adding an event (e.g. a live decision frame lands — that wiring is
// next round, this file only needs to not get in its way).
//
// Event shape (matches live.js's toReelEvent and seed.js's seedEvents, so
// all three sides agree without importing each other):
//   { id, ts, rung: 0|1|2|3|4,
//     a: { agent, human }, b: { agent, human },
//     path,
//     resolution: null | { kind: 'wait'|'abort'|'share'|'redundant'|'read-yield', detail? },
//     source: 'live' | 'generated' }
//
// The brief is explicit: never let a generated event pass as real. Every
// row carries a source tag, in plain sight, not a tooltip.

const RUNGS = [0, 1, 2, 3, 4]

const RUNG_INFO = {
  0: { label: 'co-location', color: '#8A94A3', bg: '#EEF0F3' },
  1: { label: 'read vs edit', color: '#5C8C74', bg: '#EAF2ED' },
  2: { label: 'same file', color: '#B98F2A', bg: '#FBF2DE' },
  3: { label: 'contested', color: '#C0762A', bg: '#FBEBDA' },
  4: { label: 'redundant', color: '#B0403A', bg: '#F9E5E3' },
}

const RESOLUTION_LABEL = {
  wait: 'granted the lease, other waits',
  abort: 'out-authoritied — aborted',
  share: 'split the work, no overlap',
  redundant: 'redundant work caught',
  'read-yield': 'reader yielded',
}

/** Pure event store: add, order, filter. No DOM anywhere in this class. */
export class ReelStore {
  constructor(events = []) {
    this._events = []
    this._rungFilter = 'all'
    this._humanFilter = 'all'
    for (const e of events) this.add(e)
  }

  /** Newest-first insert. Ties (equal ts) keep insertion order stable —
   *  Array.sort is stable in every engine this runs in. */
  add(event) {
    this._events.push(event)
    this._events.sort((x, y) => y.ts - x.ts)
    return event
  }

  get size() { return this._events.length }

  setRungFilter(rung) { this._rungFilter = rung }
  get rungFilter() { return this._rungFilter }

  setHumanFilter(human) { this._humanFilter = human }
  get humanFilter() { return this._humanFilter }

  /** Every human named on either side of any event, sorted, for the filter UI. */
  humans() {
    const set = new Set()
    for (const e of this._events) { set.add(e.a.human); set.add(e.b.human) }
    return [...set].sort()
  }

  /** All events, newest first, no filtering — used by 'how many total'. */
  all() { return this._events.slice() }

  /** The filtered, sorted view the panel actually renders. */
  visible() {
    return this._events.filter(e => {
      if (this._rungFilter !== 'all' && e.rung !== this._rungFilter) return false
      if (this._humanFilter !== 'all' && e.a.human !== this._humanFilter && e.b.human !== this._humanFilter) return false
      return true
    })
  }
}

// ---------------------------------------------------------------------------
// ~12 sample events so the reel is never empty on a fresh checkout. All
// source:'generated' — seed.js (built in parallel this round) has a longer,
// timestamp-spread version; this set is just enough to prove the panel out
// before that lands. Do not import seed.js here — that's next round's wiring.
// ---------------------------------------------------------------------------

const now0 = Date.now()
const minutesAgo = m => now0 - m * 60_000

export const SAMPLE_EVENTS = [
  { id: 'sample-1', ts: minutesAgo(1), rung: 3,
    a: { agent: 'agent-2', human: 'priya' }, b: { agent: 'agent-4', human: 'sara' },
    path: 'src/orders/total.ts', resolution: { kind: 'abort', detail: 'wait-die, younger aborted' },
    source: 'generated' },
  { id: 'sample-2', ts: minutesAgo(6), rung: 2,
    a: { agent: 'agent-1', human: 'priya' }, b: { agent: 'agent-3', human: 'dev' },
    path: 'src/office/agent.js', resolution: { kind: 'share' },
    source: 'generated' },
  { id: 'sample-3', ts: minutesAgo(14), rung: 4,
    a: { agent: 'agent-5', human: 'dev' }, b: { agent: 'agent-2', human: 'priya' },
    path: 'go/internal/relaysrv/waitdie.go', resolution: { kind: 'redundant', detail: 'score 0.91' },
    source: 'generated' },
  { id: 'sample-4', ts: minutesAgo(23), rung: 1,
    a: { agent: 'agent-3', human: 'dev' }, b: { agent: 'agent-1', human: 'priya' },
    path: 'src/office/live.js', resolution: { kind: 'read-yield' },
    source: 'generated' },
  { id: 'sample-5', ts: minutesAgo(31), rung: 0,
    a: { agent: 'agent-4', human: 'sara' }, b: { agent: 'agent-5', human: 'sara' },
    path: 'README.md', resolution: null,
    source: 'generated' },
  { id: 'sample-6', ts: minutesAgo(44), rung: 3,
    a: { agent: 'agent-1', human: 'priya' }, b: { agent: 'agent-2', human: 'priya' },
    path: 'src/auth/session.ts', resolution: { kind: 'wait' },
    source: 'generated' },
  { id: 'sample-7', ts: minutesAgo(58), rung: 2,
    a: { agent: 'agent-5', human: 'dev' }, b: { agent: 'agent-4', human: 'sara' },
    path: 'web/src/office/zones.js', resolution: { kind: 'share' },
    source: 'generated' },
  { id: 'sample-8', ts: minutesAgo(75), rung: 3,
    a: { agent: 'agent-3', human: 'dev' }, b: { agent: 'agent-5', human: 'dev' },
    path: 'go/internal/relaysrv/relay.go', resolution: { kind: 'abort', detail: 'priority tier' },
    source: 'generated' },
  { id: 'sample-9', ts: minutesAgo(96), rung: 4,
    a: { agent: 'agent-2', human: 'priya' }, b: { agent: 'agent-1', human: 'priya' },
    path: 'web/test/office-live.test.ts', resolution: { kind: 'redundant', detail: 'score 0.84' },
    source: 'generated' },
  { id: 'sample-10', ts: minutesAgo(120), rung: 1,
    a: { agent: 'agent-4', human: 'sara' }, b: { agent: 'agent-3', human: 'dev' },
    path: 'package.json', resolution: { kind: 'read-yield' },
    source: 'generated' },
  { id: 'sample-11', ts: minutesAgo(150), rung: 0,
    a: { agent: 'agent-1', human: 'priya' }, b: { agent: 'agent-4', human: 'sara' },
    path: 'src/office/dressing.js', resolution: null,
    source: 'generated' },
  { id: 'sample-12', ts: minutesAgo(190), rung: 3,
    a: { agent: 'agent-5', human: 'dev' }, b: { agent: 'agent-2', human: 'priya' },
    path: 'src/office/clips/argue.js', resolution: { kind: 'wait' },
    source: 'generated' },
]

// ---------------------------------------------------------------------------
// Render layer. Everything below touches the DOM; everything above doesn't.
// ---------------------------------------------------------------------------

function relTime(ts, now) {
  const s = Math.max(0, Math.round((now - ts) / 1000))
  if (s < 5) return 'just now'
  if (s < 60) return `${s}s ago`
  const m = Math.round(s / 60)
  if (m < 60) return `${m}m ago`
  const h = Math.round(m / 60)
  if (h < 24) return `${h}h ago`
  return `${Math.round(h / 24)}d ago`
}

function pathLeaf(path) {
  const parts = path.split('/')
  return parts.length <= 2 ? path : '…/' + parts.slice(-2).join('/')
}

function rowHtml(e, now) {
  const info = RUNG_INFO[e.rung]
  const res = e.resolution ? (RESOLUTION_LABEL[e.resolution.kind] || e.resolution.kind) : 'still live'
  const sourceTag = e.source === 'live'
    ? '<span class="reel-src reel-src-live">live</span>'
    : '<span class="reel-src reel-src-gen">generated</span>'
  return `<button class="reel-row" data-id="${escapeAttr(e.id)}">
    <span class="reel-badge" style="color:${info.color};background:${info.bg}">R${e.rung}</span>
    <span class="reel-body">
      <span class="reel-line1">
        <span class="reel-who">${escapeHtml(e.a.human)}/${escapeHtml(e.a.agent)}</span>
        <span class="reel-vs">vs</span>
        <span class="reel-who">${escapeHtml(e.b.human)}/${escapeHtml(e.b.agent)}</span>
        ${sourceTag}
      </span>
      <span class="reel-line2">
        <span class="reel-path" title="${escapeAttr(e.path)}">${escapeHtml(pathLeaf(e.path))}</span>
        <span class="reel-dot">·</span>
        <span class="reel-res">${escapeHtml(res)}</span>
      </span>
    </span>
    <span class="reel-time">${relTime(e.ts, now)}</span>
  </button>`
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]))
}
function escapeAttr(s) { return escapeHtml(s) }

/**
 * Mount the reel panel into `container`. Draws filter chips (rung + human),
 * the scrollable list, and a footer line the caller can drive independently
 * (office.html uses this to keep the old #beat text alive).
 *
 * @param {HTMLElement} container
 * @param {ReelStore} store
 * @param {{ onSelect?: (event:object)=>void }} [opts]
 * @returns {{ render():void, setFoot(html:string):void }}
 */
export function mountReel(container, store, opts = {}) {
  const onSelect = opts.onSelect || (() => {})

  container.innerHTML = `
    <div class="reel-head">
      <span class="reel-title">highlight reel</span>
      <span class="reel-count"></span>
    </div>
    <div class="reel-filters">
      <div class="reel-chips" data-role="rung"></div>
      <select class="reel-human" data-role="human"></select>
    </div>
    <div class="reel-list" data-role="list"></div>
    <div class="reel-foot" data-role="foot"></div>
  `

  const countEl = container.querySelector('.reel-count')
  const chipsEl = container.querySelector('[data-role="rung"]')
  const humanEl = container.querySelector('[data-role="human"]')
  const listEl = container.querySelector('[data-role="list"]')
  const footEl = container.querySelector('[data-role="foot"]')

  function renderChips() {
    const items = ['all', ...RUNGS]
    chipsEl.innerHTML = items.map(r => {
      const active = store.rungFilter === r
      const label = r === 'all' ? 'all' : `R${r}`
      return `<button class="reel-chip${active ? ' on' : ''}" data-rung="${r}">${label}</button>`
    }).join('')
    for (const btn of chipsEl.querySelectorAll('button')) {
      btn.onclick = () => {
        const v = btn.dataset.rung
        store.setRungFilter(v === 'all' ? 'all' : Number(v))
        render()
      }
    }
  }

  function renderHumans() {
    const humans = store.humans()
    const current = store.humanFilter
    humanEl.innerHTML = ['<option value="all">everyone</option>']
      .concat(humans.map(h => `<option value="${escapeAttr(h)}">${escapeHtml(h)}</option>`))
      .join('')
    humanEl.value = humans.includes(current) ? current : 'all'
  }
  humanEl.onchange = () => { store.setHumanFilter(humanEl.value); render() }

  function render() {
    renderChips()
    renderHumans()
    const now = Date.now()
    const visible = store.visible()
    countEl.textContent = `${visible.length}/${store.size}`
    if (visible.length === 0) {
      listEl.innerHTML = `<div class="reel-empty">nothing here — try a wider filter</div>`
    } else {
      listEl.innerHTML = visible.map(e => rowHtml(e, now)).join('')
      for (const row of listEl.querySelectorAll('.reel-row')) {
        row.onclick = () => {
          const e = visible.find(x => x.id === row.dataset.id)
          if (e) onSelect(e)
        }
      }
    }
  }

  function setFoot(html) { footEl.innerHTML = html }

  render()
  return { render, setFoot }
}
