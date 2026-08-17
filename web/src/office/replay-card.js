// The "versus card": an alternative to the bare #caption line for a reel
// replay. Four visual takes, picked by ?vcard=split|strip|ticket|bout in
// office.html, all off by default — plain caption() is still what plays
// unless a param opts in, so this never changes what an existing checkout
// looks like. See caption.js for the arbiter that keeps this and the demo's
// own captions from stepping on each other while a replay is live.
//
// The five rung colors are kept here rather than imported from reel.js —
// reel.js has no shared export for them (its own rung lookup, RUNG_EXPLAIN,
// is prose for the detail view, not a color table), so this is a plain copy,
// same "small table duplicated across the toolchain boundary" pattern
// office.html's own RESOLUTION_LABEL comment and live.js's HAIR array
// already use for the same reason: office/*.js modules don't reach into
// each other's internals for one lookup literal.
const RUNG_COLORS = {
  0: { color: '#8A94A3', bg: '#EEF0F3' },
  1: { color: '#5C8C74', bg: '#EAF2ED' },
  2: { color: '#B98F2A', bg: '#FBF2DE' },
  3: { color: '#C0762A', bg: '#FBEBDA' },
  4: { color: '#B0403A', bg: '#F9E5E3' },
}
const RUNG_LABEL = {
  0: 'co-location', 1: 'read vs edit', 2: 'same file', 3: 'contested', 4: 'redundant',
}

const VARIANTS = ['split', 'strip', 'ticket', 'bout']

// How long the CSS fade/slide-out actually runs (see STYLE below, .rcard's
// own transition). hide() waits this long before clearing innerHTML, so a
// stale variant's markup never flashes as the *next* show() fades a new one
// in — see show()'s own cancel-pending-exit note.
const EXIT_MS = 300

function who(side) {
  const human = side && side.human, agent = side && side.agent
  return { human: human || '—', agent: agent || 'unnamed agent' }
}

function badge(rung) {
  const c = RUNG_COLORS[rung] || RUNG_COLORS[0]
  const label = RUNG_LABEL[rung] || `rung ${rung}`
  return `<span class="rcard-badge" style="color:${c.color};background:${c.bg}">${label}</span>`
}

function renderSplit(A, B, rung, label) {
  return `
    <div class="rcard-side rcard-a"><b>${A.human}</b><span>${A.agent}</span></div>
    <div class="rcard-mid">${badge(rung)}<div class="rcard-verdict">${label}</div></div>
    <div class="rcard-side rcard-b"><b>${B.human}</b><span>${B.agent}</span></div>`
}

function renderStrip(A, B, rung, label) {
  return `${badge(rung)} <b>${A.human}/${A.agent}</b> vs <b>${B.human}/${B.agent}</b> — ${label}`
}

// Torn-edge admission ticket, warm paper tones, rung spelled out as the
// ticket's "class" the way a real stub prints a seat class or fare tier.
// Meant to sit alongside the reel's paper skin. The notches are cut with
// mask-image radial-gradients (see STYLE) rather than an svg or extra
// elements, so this stays markup-identical in shape to the other variants:
// three children, badge in the middle, same show()/hide() contract.
function renderTicket(A, B, rung, label) {
  const cls = RUNG_LABEL[rung] || `rung ${rung}`
  return `
    <div class="rcard-side rcard-a"><b>${A.human}</b><span>${A.agent}</span></div>
    <div class="rcard-mid">${badge(rung)}<div class="rcard-verdict">${label}</div>
      <div class="rcard-ticket-class">class: ${cls}</div></div>
    <div class="rcard-side rcard-b"><b>${B.human}</b><span>${B.agent}</span></div>`
}

// Arcade fight-card: big rung badge dead center standing in for the "VS",
// verdict stamped at an angle like a K.O. card. Reads best over the glass/
// ticker skins where the reel is already leaning arcade-HUD.
function renderBout(A, B, rung, label) {
  return `
    <div class="rcard-side rcard-a"><b>${A.human}</b><span>${A.agent}</span></div>
    <div class="rcard-mid">${badge(rung)}</div>
    <div class="rcard-side rcard-b"><b>${B.human}</b><span>${B.agent}</span></div>
    <div class="rcard-stamp">${label}</div>`
}

const RENDER = { split: renderSplit, strip: renderStrip, ticket: renderTicket, bout: renderBout }

// Every visual rule for every variant lives here, not in office.html's own
// CSS — that keeps "same data in, CSS-only differences" true of the whole
// module, not just the render functions: mounting createReplayCard anywhere
// (office.html, vcard-test.html) gets a working card with no separate CSS
// block for the caller to remember to include. Injected once per document,
// guarded by an id check, the same "idempotent style injection" shape
// dressing.js already uses for its own generated CSS.
const STYLE = `
.rcard{position:fixed;left:50%;bottom:34px;transform:translateX(-50%) translateY(14px);
  max-width:min(720px,90vw);opacity:0;pointer-events:none;
  transition:opacity ${EXIT_MS}ms,transform ${EXIT_MS}ms;
  font:14px ui-sans-serif,sans-serif;color:#F0ECE6}
.rcard.on{opacity:1;transform:translateX(-50%) translateY(0)}
.rcard-badge{font:700 10px ui-monospace,monospace;text-transform:uppercase;
  letter-spacing:.04em;border-radius:999px;padding:2px 8px}
.rcard.split{display:flex;align-items:stretch;gap:0;
  background:#35455Cf2;border-radius:12px;box-shadow:0 8px 30px #4a1f3d33;overflow:hidden}
.rcard.split .rcard-side{flex:1 1 0;padding:12px 18px;display:flex;flex-direction:column;
  gap:2px;min-width:0;transition:transform .4s cubic-bezier(.2,.8,.2,1)}
.rcard.split .rcard-side b{font-size:14px;letter-spacing:-.01em}
.rcard.split .rcard-side span{font:11px ui-monospace,monospace;color:#C7CDD8;
  overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.rcard.split .rcard-a{text-align:right;align-items:flex-end;border-right:1px solid #ffffff22}
.rcard.split .rcard-b{text-align:left;align-items:flex-start}
.rcard.split:not(.on) .rcard-a{transform:translateX(-24px)}
.rcard.split:not(.on) .rcard-b{transform:translateX(24px)}
.rcard.split .rcard-mid{flex:0 0 auto;padding:10px 16px;display:flex;
  flex-direction:column;align-items:center;gap:5px;justify-content:center}
.rcard.split .rcard-verdict{font-size:12px;color:#F0ECE6;text-align:center;max-width:180px}
.rcard.strip{background:#35455Cf2;border-radius:999px;padding:8px 16px;
  box-shadow:0 6px 20px #4a1f3d33;display:flex;align-items:center;gap:8px;
  font:12px ui-monospace,monospace;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.rcard.ticket{display:flex;align-items:stretch;gap:0;background:linear-gradient(135deg,#F8F1DE,#EFE2C4);
  color:#3B2F1E;border-radius:6px;box-shadow:0 10px 26px #2b1c0033;
  --notch:9px;-webkit-mask-image:radial-gradient(circle at 0 50%,transparent var(--notch),#000 calc(var(--notch) + 1px)),
    radial-gradient(circle at 100% 50%,transparent var(--notch),#000 calc(var(--notch) + 1px));
  mask-image:radial-gradient(circle at 0 50%,transparent var(--notch),#000 calc(var(--notch) + 1px)),
    radial-gradient(circle at 100% 50%,transparent var(--notch),#000 calc(var(--notch) + 1px))}
.rcard.ticket:not(.on){transform:translateX(-50%) translateY(14px) scale(.97)}
.rcard.ticket .rcard-side{flex:1 1 0;padding:12px 20px;display:flex;flex-direction:column;
  gap:2px;min-width:0;color:#3B2F1E}
.rcard.ticket .rcard-side span{font:11px ui-monospace,monospace;color:#7A6A48;
  overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.rcard.ticket .rcard-a{text-align:right;align-items:flex-end;
  border-right:2px dashed #C9B888}
.rcard.ticket .rcard-b{text-align:left;align-items:flex-start;border-left:2px dashed #C9B888}
.rcard.ticket .rcard-mid{flex:0 0 auto;padding:10px 18px;display:flex;
  flex-direction:column;align-items:center;gap:4px;justify-content:center}
.rcard.ticket .rcard-verdict{font-size:12px;color:#3B2F1E;text-align:center;max-width:180px}
.rcard.ticket .rcard-ticket-class{font:700 9px ui-monospace,monospace;text-transform:uppercase;
  letter-spacing:.06em;color:#8A6D2F}
.rcard.bout{position:relative;display:flex;align-items:center;gap:16px;
  background:linear-gradient(180deg,#171B24,#05060A);border:2px solid #FFD34E;
  padding:14px 30px;clip-path:polygon(14px 0,100% 0,calc(100% - 14px) 100%,0 100%)}
.rcard.bout:not(.on){transform:translateX(-50%) translateY(14px) scale(.95)}
.rcard.bout .rcard-side{flex:1 1 0;min-width:0;display:flex;flex-direction:column;gap:2px}
.rcard.bout .rcard-a{text-align:right;align-items:flex-end}
.rcard.bout .rcard-b{text-align:left;align-items:flex-start}
.rcard.bout .rcard-side b{font-size:14px;letter-spacing:-.01em;color:#F3EFE4}
.rcard.bout .rcard-side span{font:11px ui-monospace,monospace;color:#8A93A6;
  overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.rcard.bout .rcard-mid{flex:0 0 auto;display:flex;align-items:center;justify-content:center}
.rcard.bout .rcard-stamp{position:absolute;top:-11px;right:16px;transform:rotate(-7deg);
  border:2px solid #E4574A;border-radius:5px;padding:2px 9px;color:#E4574A;
  font:800 10px ui-monospace,monospace;text-transform:uppercase;letter-spacing:.05em;
  background:#05060Ac0}

/* Every variant's entrance is a CSS transition (opacity/transform) driven
   by the .on class toggle in show()/hide() below, not a @keyframes
   animation — near-zero duration is enough to turn "slides and fades in"
   into "appears", same blanket pattern as office.html's #reel block. The
   .rcard-stamp's rotate(-7deg) isn't animated, it's a static tilt, so
   nothing to do for it here. */
@media (prefers-reduced-motion: reduce){
  .rcard, .rcard *{transition-duration:.01ms!important}
}
`

let stylesInjected = false
function ensureStyles() {
  if (stylesInjected) return
  if (typeof document === 'undefined') return
  if (document.getElementById('rcard-styles')) { stylesInjected = true; return }
  const el = document.createElement('style')
  el.id = 'rcard-styles'
  el.textContent = STYLE
  document.head.appendChild(el)
  stylesInjected = true
}

/**
 * Mounts nothing by itself — `variant` null/undefined means "off", and
 * show()/hide() become no-ops so a caller can wire this in unconditionally
 * without an extra guard at every call site. Pass 'split', 'strip',
 * 'ticket' or 'bout' to actually render.
 */
export function createReplayCard(container, variant) {
  if (!variant || !VARIANTS.includes(variant)) {
    return { show() {}, hide() {}, variant: null }
  }
  ensureStyles()
  container.className = `rcard ${variant}`
  const render = RENDER[variant]

  let exitTimer = null

  function show({ a, b, rung, label }) {
    // A show() mid-exit must win outright: cancel the pending clear so the
    // new card's own fade-in isn't undercut a moment later by the old
    // exit's delayed innerHTML wipe landing on top of it.
    if (exitTimer !== null) { clearTimeout(exitTimer); exitTimer = null }
    const A = who(a), B = who(b)
    container.innerHTML = render(A, B, rung, label)
    container.classList.add('on')
  }

  function hide() {
    if (exitTimer !== null) return   // already fading out, let it finish
    container.classList.remove('on')
    exitTimer = setTimeout(() => {
      container.innerHTML = ''
      exitTimer = null
    }, EXIT_MS)
  }

  return { show, hide, variant }
}
