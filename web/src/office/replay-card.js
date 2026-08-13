// The "versus card": an alternative to the bare #caption line for a reel
// replay. Two visual takes, picked by ?vcard=split|strip in office.html,
// both off by default — plain caption() is still what plays unless a
// param opts in, so this never changes what an existing checkout looks
// like. See caption.js for the arbiter that keeps this and the demo's own
// captions from stepping on each other while a replay is live.
//
// The five rung colors are copied from reel.js's RUNG_INFO rather than
// imported — office.html/reel.js/live.js already keep small copies of
// each other's tiny lookup tables across this same toolchain boundary
// (see office.html's own RESOLUTION_LABEL comment) rather than reach into
// one another's internals for one map literal.
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

function who(side) {
  const human = side && side.human, agent = side && side.agent
  return { human: human || '—', agent: agent || 'unnamed agent' }
}

function badge(rung) {
  const c = RUNG_COLORS[rung] || RUNG_COLORS[0]
  const label = RUNG_LABEL[rung] || `rung ${rung}`
  return `<span class="rcard-badge" style="color:${c.color};background:${c.bg}">${label}</span>`
}

/**
 * Mounts nothing by itself — `variant` null/undefined means "off", and
 * show()/hide() become no-ops so a caller can wire this in unconditionally
 * without an extra guard at every call site. Pass 'split' or 'strip' to
 * actually render.
 */
export function createReplayCard(container, variant) {
  if (!variant || (variant !== 'split' && variant !== 'strip')) {
    return { show() {}, hide() {}, variant: null }
  }
  container.className = `rcard ${variant}`

  function show({ a, b, rung, label }) {
    const A = who(a), B = who(b)
    if (variant === 'split') {
      container.innerHTML = `
        <div class="rcard-side rcard-a"><b>${A.human}</b><span>${A.agent}</span></div>
        <div class="rcard-mid">${badge(rung)}<div class="rcard-verdict">${label}</div></div>
        <div class="rcard-side rcard-b"><b>${B.human}</b><span>${B.agent}</span></div>`
    } else {
      container.innerHTML =
        `${badge(rung)} <b>${A.human}/${A.agent}</b> vs <b>${B.human}/${B.agent}</b> — ${label}`
    }
    container.classList.add('on')
  }

  function hide() {
    container.classList.remove('on')
  }

  return { show, hide, variant }
}
