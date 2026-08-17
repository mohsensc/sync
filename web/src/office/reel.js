// The highlight reel: every clash between agents, ranked by rung, newest
// first. Two layers, same split as live.js — pure logic, then a thin DOM
// layer that draws it.
//
// ReelStore holds events and answers filtered/sorted views. It has no idea
// what a <div> is, so it's unit tested the same way LiveDirector is (see
// test/office-reel.test.ts) — plain describe/it, no DOM. UI-adjacent state
// that still has no DOM opinion (which row is expanded, which one is
// "now playing", how many rows are revealed, which live rows just arrived)
// lives here too, for the same reason: it's state, not markup, and it's
// cheaper to get right in a test than in a browser.
//
// mountReel() takes a container element and a store and draws rows into it.
// It re-renders on filter clicks and whenever the caller calls render()
// after adding an event (e.g. a live decision frame lands).
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

// Sort treatments for the panel. 'new' is the original chronological order
// and stays the default — a fresh checkout looks exactly like it always
// has. 'worst' answers the brief's "ranked by severity" literally: rung
// descending, newest-first as the tiebreak within a rung so it doesn't
// just become a second chronological view. 'worst-grouped' is the same
// order with a rung divider between groups — cheap once 'worst' exists
// (see groupHeadHtml below), and worth having as its own option since a
// long worst-first list without dividers reads like one undifferentiated
// wall of red/orange badges.
export const SORT_MODES = ['new', 'worst', 'worst-grouped']
const SORT_LABEL = { new: 'newest', worst: 'worst', 'worst-grouped': 'worst · grouped' }

// Visual treatments for the panel. Colors live entirely in CSS now (see
// office.html's reel CSS block and reel-skins-test.html's copy of it) keyed
// off `.reel-badge[data-rung]` — rowHtml below only ever writes the rung
// number as a data attribute, never a color, so a skin can restyle every
// badge without touching this file. 'paper' is the original warm-card look
// and stays the default; a fresh checkout with no ?skin= param looks
// exactly like it always has.
export const SKINS = ['paper', 'glass', 'ticker']

/** Pure param -> skin resolution, no DOM. Anything unrecognized (missing
 *  param, typo, null) falls back to 'paper' rather than rendering broken. */
export function resolveSkin(value) {
  return SKINS.includes(value) ? value : 'paper'
}

const RESOLUTION_LABEL = {
  wait: 'granted the lease, other waits',
  abort: 'out-authoritied — aborted',
  share: 'split the work, no overlap',
  redundant: 'redundant work caught',
  'read-yield': 'reader yielded',
}

// One plain-English line per rung, for the detail view. Deliberately talks
// about the file, not a symbol — the event shape doesn't carry a symbol
// name (that's `path`-only, see the header above), so "parseConfig" in the
// brief's own example is illustrative, not a literal field this reads.
const RUNG_EXPLAIN = {
  0: (e) => `${e.a.human}/${e.a.agent} and ${e.b.human}/${e.b.agent} were just nearby — no real conflict.`,
  1: (e) => `one of them was reading ${pathLeaf(e.path)} while the other edited it — low risk, worth a glance.`,
  2: (e) => `both touching ${pathLeaf(e.path)}, different parts — safe to work side by side.`,
  3: (e) => `both wanted the same piece of ${pathLeaf(e.path)} — contested.`,
  4: (e) => `both were building something like ${pathLeaf(e.path)} in different files — redundant work caught.`,
}

const REVEAL_STEP = 40

/** Pure event + UI-state store: add, order, filter, and the bits of
 *  interaction state (open row, playing row, reveal cap, arrival marks)
 *  that don't need a DOM to be correct. No DOM anywhere in this class. */
export class ReelStore {
  constructor(events = []) {
    this._events = []
    this._rungFilter = 'all'
    this._humanFilter = 'all'
    this._sortMode = 'new'
    this._openId = null
    this._playingId = null
    this._revealCount = REVEAL_STEP
    this._newLiveIds = []
    for (const e of events) this.add(e)
  }

  /** Newest-first insert. Ties (equal ts) keep insertion order stable —
   *  Array.sort is stable in every engine this runs in. Live-sourced
   *  events are also queued for `takeNewLiveIds()` so the render layer can
   *  flash them once without the store knowing what a flash is. */
  add(event) {
    this._events.push(event)
    this._events.sort((x, y) => y.ts - x.ts)
    if (event.source === 'live') this._newLiveIds.push(event.id)
    return event
  }

  get size() { return this._events.length }

  setRungFilter(rung) { this._rungFilter = rung; this.resetReveal() }
  get rungFilter() { return this._rungFilter }

  setHumanFilter(human) { this._humanFilter = human; this.resetReveal() }
  get humanFilter() { return this._humanFilter }

  /** Unrecognized values fall back to 'new' rather than silently keeping
   *  whatever was set before — same "don't render broken" posture as
   *  resolveSkin(). Changing sort doesn't reset the reveal cap: unlike a
   *  filter, re-sorting the same set of rows shouldn't punt you back to
   *  the top of a long list you'd already paged into. */
  setSortMode(mode) { this._sortMode = SORT_MODES.includes(mode) ? mode : 'new' }
  get sortMode() { return this._sortMode }

  /** Every human named on either side of any event, sorted, for the filter UI. */
  humans() {
    const set = new Set()
    for (const e of this._events) { set.add(e.a.human); set.add(e.b.human) }
    return [...set].sort()
  }

  /** All events, newest first, no filtering — used by 'how many total'. */
  all() { return this._events.slice() }

  /** The filtered, sorted view — every match, uncapped. `page()` is what
   *  the panel actually renders; this stays around for counts and tests.
   *  `_events` is always maintained newest-first (see add()), so 'new'
   *  returns the filtered slice as-is; 'worst'/'worst-grouped' re-sort by
   *  rung descending with newest-first as the tiebreak, on a copy —
   *  `_events`'s own order is never touched by which sort mode is active. */
  visible() {
    const filtered = this._events.filter(e => {
      if (this._rungFilter !== 'all' && e.rung !== this._rungFilter) return false
      if (this._humanFilter !== 'all' && e.a.human !== this._humanFilter && e.b.human !== this._humanFilter) return false
      return true
    })
    if (this._sortMode === 'new') return filtered
    return filtered.sort((x, y) => (y.rung - x.rung) || (y.ts - x.ts))
  }

  // ---- detail row -------------------------------------------------------
  /** Selecting a row a second time closes it — one open row at a time. */
  toggleOpen(id) { this._openId = (this._openId === id) ? null : id }
  get openId() { return this._openId }
  closeOpen() { this._openId = null }

  // ---- "now playing" ------------------------------------------------------
  /** The caller (office.html's replay dispatch) sets this when a replay
   *  starts and clears it when the beat finishes — replay is async, so
   *  this can't just be derived from the click. `null` means nothing's
   *  playing. */
  setPlaying(id) { this._playingId = id }
  clearPlaying() { this._playingId = null }
  get playingId() { return this._playingId }

  // ---- long-list handling ------------------------------------------------
  /** How many rows of the current filtered view to actually draw. Resets
   *  to the cap whenever a filter changes (a fresh filtered list should
   *  start capped, not carry over how far a different list was expanded). */
  get revealCount() { return this._revealCount }
  resetReveal() { this._revealCount = REVEAL_STEP }
  showMore(step = REVEAL_STEP) { this._revealCount += step }

  /** The capped page the panel draws, plus how many are held back. */
  page() {
    const v = this.visible()
    return { shown: v.slice(0, this._revealCount), remaining: Math.max(0, v.length - this._revealCount) }
  }

  // ---- arrivals ------------------------------------------------------------
  /** Ids added since the last call, live-sourced only (generated/seed rows
   *  don't flash — only real relay frames count as an "arrival"). Consumes
   *  the queue: calling this twice in a row returns [] the second time. */
  takeNewLiveIds() {
    const ids = this._newLiveIds
    this._newLiveIds = []
    return ids
  }
}

// ---------------------------------------------------------------------------
// ~12 sample events so the reel is never empty on a fresh checkout. All
// source:'generated' — seed.js has a longer, timestamp-spread version;
// office.html spreads both in. Do not import seed.js here.
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

/** Exported for tests — timestamp bucket formatting is easy to get off-by-
 *  one on and cheap to check without a DOM. */
export function relTime(ts, now) {
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

function resolutionPhrase(e) {
  if (!e.resolution) return 'still live — no resolution yet'
  const base = RESOLUTION_LABEL[e.resolution.kind] || e.resolution.kind
  return e.resolution.detail ? `${base} (${e.resolution.detail})` : base
}

function sourceTagHtml(e) {
  return e.source === 'live'
    ? '<span class="reel-src reel-src-live">live</span>'
    : '<span class="reel-src reel-src-gen">generated</span>'
}

function rowHtml(e, now, state) {
  const res = e.resolution ? (RESOLUTION_LABEL[e.resolution.kind] || e.resolution.kind) : 'still live'
  const open = state.openId === e.id
  const playing = state.playingId === e.id
  const isNew = state.newIds.has(e.id)
  const rowClass = ['reel-row', open && 'reel-row-open', playing && 'reel-row-playing', isNew && 'reel-row-new']
    .filter(Boolean).join(' ')

  const detail = open ? `
    <div class="reel-detail">
      <div class="reel-detail-row">
        <span class="reel-detail-label">path</span>
        <span class="reel-detail-value reel-detail-path">${escapeHtml(e.path)}</span>
      </div>
      <p class="reel-detail-explain">${escapeHtml((RUNG_EXPLAIN[e.rung] || (() => ''))(e))}</p>
      <div class="reel-detail-row">
        <span class="reel-detail-label">resolved</span>
        <span class="reel-detail-value">${escapeHtml(resolutionPhrase(e))}</span>
      </div>
      <div class="reel-detail-row">
        <span class="reel-detail-label">source</span>
        <span class="reel-detail-value">${sourceTagHtml(e)}</span>
      </div>
      <button class="reel-replay-btn" data-replay="${escapeAttr(e.id)}"${playing ? ' disabled' : ''}>
        ${playing ? 'playing…' : '▶ replay'}
      </button>
    </div>` : ''

  return `<div class="reel-item">
    <div class="${rowClass}" data-id="${escapeAttr(e.id)}" data-ts="${e.ts}"
         role="button" tabindex="0" aria-expanded="${open}">
      <span class="reel-badge" data-rung="${e.rung}">R${e.rung}</span>
      <span class="reel-body">
        <span class="reel-line1">
          <span class="reel-who">${escapeHtml(e.a.human)}/${escapeHtml(e.a.agent)}</span>
          <span class="reel-vs">vs</span>
          <span class="reel-who">${escapeHtml(e.b.human)}/${escapeHtml(e.b.agent)}</span>
          ${sourceTagHtml(e)}
        </span>
        <span class="reel-line2">
          <span class="reel-path" title="${escapeAttr(e.path)}">${escapeHtml(pathLeaf(e.path))}</span>
          <span class="reel-dot">·</span>
          <span class="reel-res">${escapeHtml(res)}</span>
        </span>
      </span>
      <span class="reel-time">${relTime(e.ts, now)}</span>
    </div>${detail}
  </div>`
}

/** A rung divider for 'worst-grouped' mode. Reuses `.reel-badge` (already
 *  themed per-rung by every skin, see the badge rules at the bottom of
 *  office.html's base CSS and each skin's own copy) instead of adding a
 *  new class, so this needs zero CSS of its own — the layout below is
 *  inline because this file doesn't own office.html's markup-adjacent
 *  CSS, only the skins block, and a divider is cheap enough as inline
 *  style that it isn't worth asking for a CSS home. */
function groupHeadHtml(rung) {
  return `<div class="reel-group-head" style="display:flex;align-items:center;
    gap:8px;padding:8px 14px 3px;opacity:.9">
    <span class="reel-badge" data-rung="${rung}" style="margin-top:0">R${rung}</span>
    <span style="flex:1 1 auto;height:1px;background:currentColor;opacity:.14"></span>
  </div>`
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
 * Clicking a row opens/closes its detail card — it does not replay by
 * itself. The detail card's own "replay" button is the thing that calls
 * `onSelect`, so there is exactly one path into playback (the brief for
 * this round asked for that split explicitly, so the two-act replay work
 * has a single entry point to drive instead of guessing which click meant
 * "tell me more" vs "play it").
 *
 * Sort is a second cycle button next to the skin one — 'new' (default,
 * today's chronological order), 'worst' (rung descending, ranked-by-
 * severity per the brief), 'worst-grouped' (same order with a rung
 * divider between groups). Store-side state (`ReelStore.sortMode`), same
 * split as skin: this function just draws whatever the store says.
 *
 * Skin is a class on `container`, not a prop threaded through every draw
 * call — `reel-skin-<name>`, one of `SKINS`. `opts.skin` sets the initial
 * one (already resolved through `resolveSkin`, this function doesn't
 * re-validate); a button in the head cycles through the rest so the owner
 * can flip looks without editing a URL. All three skins render the exact
 * same markup — only office.html's CSS (and reel-skins-test.html's copy of
 * it) differs — so filtering, paging, replay, all of it works identically
 * regardless of which one is showing.
 *
 * @param {HTMLElement} container
 * @param {ReelStore} store
 * @param {{ onSelect?: (event:object)=>void, skin?: string }} [opts]
 * @returns {{ render():void, setFoot(html:string):void, setPlaying(id:string|null):void, clearPlaying():void, getSkin():string, setSkin(skin:string):void, dispose():void }}
 */
export function mountReel(container, store, opts = {}) {
  const onSelect = opts.onSelect || (() => {})
  let skin = SKINS.includes(opts.skin) ? opts.skin : 'paper'

  container.innerHTML = `
    <div class="reel-head">
      <span class="reel-title">highlight reel</span>
      <span class="reel-head-right">
        <span class="reel-count"></span>
        <button class="reel-skin-btn" data-role="sort-btn" type="button"></button>
        <button class="reel-skin-btn" data-role="skin-btn" type="button"></button>
      </span>
    </div>
    <div class="reel-filters">
      <div class="reel-chips" data-role="rung"></div>
      <select class="reel-human" data-role="human" name="reel-human" aria-label="filter by human"></select>
    </div>
    <div class="reel-list" data-role="list"></div>
    <div class="reel-foot" data-role="foot"></div>
  `

  const countEl = container.querySelector('.reel-count')
  const chipsEl = container.querySelector('[data-role="rung"]')
  const humanEl = container.querySelector('[data-role="human"]')
  const listEl = container.querySelector('[data-role="list"]')
  const footEl = container.querySelector('[data-role="foot"]')
  const skinBtn = container.querySelector('[data-role="skin-btn"]')
  const sortBtn = container.querySelector('[data-role="sort-btn"]')

  function applySortLabel() {
    const mode = store.sortMode
    const next = SORT_MODES[(SORT_MODES.indexOf(mode) + 1) % SORT_MODES.length]
    sortBtn.textContent = SORT_LABEL[mode]
    sortBtn.title = `sort: ${SORT_LABEL[mode]} — click for ${SORT_LABEL[next]}`
    sortBtn.setAttribute('aria-label', sortBtn.title)
  }
  sortBtn.onclick = () => {
    store.setSortMode(SORT_MODES[(SORT_MODES.indexOf(store.sortMode) + 1) % SORT_MODES.length])
    render()
  }

  function applySkinClass() {
    for (const s of SKINS) container.classList.remove(`reel-skin-${s}`)
    container.classList.add(`reel-skin-${skin}`)
    skinBtn.textContent = skin
    skinBtn.title = `look: ${skin} — click for ${SKINS[(SKINS.indexOf(skin) + 1) % SKINS.length]}`
    skinBtn.setAttribute('aria-label', skinBtn.title)
  }
  skinBtn.onclick = () => {
    skin = SKINS[(SKINS.indexOf(skin) + 1) % SKINS.length]
    applySkinClass()
  }
  applySkinClass()

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
    applySortLabel()
    const now = Date.now()
    const visible = store.visible()
    const { shown, remaining } = store.page()
    const newIds = new Set(store.takeNewLiveIds())
    countEl.textContent = `${visible.length}/${store.size}`
    if (shown.length === 0) {
      listEl.innerHTML = `<div class="reel-empty">nothing here — try a wider filter</div>`
      return
    }
    const state = { openId: store.openId, playingId: store.playingId, newIds }
    const grouped = store.sortMode === 'worst-grouped'
    let lastRung = null
    const rows = shown.map(e => {
      const head = grouped && e.rung !== lastRung ? groupHeadHtml(e.rung) : ''
      lastRung = e.rung
      return head + rowHtml(e, now, state)
    }).join('')
    const more = remaining > 0
      ? `<button class="reel-more" data-more="1">show ${Math.min(remaining, REVEAL_STEP)} older</button>`
      : ''
    listEl.innerHTML = rows + more

    for (const row of listEl.querySelectorAll('.reel-row')) {
      const activate = () => { store.toggleOpen(row.dataset.id); render() }
      row.onclick = activate
      row.onkeydown = (ev) => {
        if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); activate() }
      }
    }
    for (const btn of listEl.querySelectorAll('.reel-replay-btn')) {
      btn.onclick = (ev) => {
        ev.stopPropagation()
        const id = btn.dataset.replay
        const e = shown.find(x => x.id === id) || visible.find(x => x.id === id)
        if (e) onSelect(e)
      }
    }
    const moreBtn = listEl.querySelector('.reel-more')
    if (moreBtn) moreBtn.onclick = () => { store.showMore(); render() }
  }

  /** Update only the `n ago` text, not the whole list — so a slow tick
   *  doesn't blow away an open detail card or restart an arrival flash. */
  function retimeOnly() {
    const now = Date.now()
    for (const row of listEl.querySelectorAll('.reel-row[data-ts]')) {
      const ts = Number(row.dataset.ts)
      const timeEl = row.querySelector('.reel-time')
      if (timeEl) timeEl.textContent = relTime(ts, now)
    }
  }
  const retimeTimer = setInterval(retimeOnly, 20_000)

  function setFoot(html) { footEl.innerHTML = html }
  function setPlaying(id) { store.setPlaying(id); render() }
  function clearPlaying() { store.clearPlaying(); render() }
  function getSkin() { return skin }
  function setSkin(next) {
    if (!SKINS.includes(next)) return
    skin = next
    applySkinClass()
  }
  function dispose() { clearInterval(retimeTimer) }

  render()
  return { render, setFoot, setPlaying, clearPlaying, getSkin, setSkin, dispose }
}
