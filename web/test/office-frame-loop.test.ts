import { describe, it, expect } from 'vitest'
import ghostSrc from '../src/office/ghost.js?raw'
import interactSrc from '../src/office/interact.js?raw'
import gitsignalsSrc from '../src/office/gitsignals.js?raw'
import histshelfSrc from '../src/office/histshelf.js?raw'

// office.html runs exactly one requestAnimationFrame loop and calls each
// module's tick(dt) from it. These four modules used to each start their
// own on top of it — ghost.js's fade/sway, interact.js's desk-breathe AND
// hover-pulse (two), gitsignals.js's churn glow, histshelf.js's strip
// pinning — six loops total, no shared budget, no way for the page to
// throttle or skip any of them.
//
// This is a static source scan, not a DOM test: none of node's test env
// has requestAnimationFrame, and these files already guard their old
// self-starting call behind `typeof requestAnimationFrame === 'function'`
// — importing and attaching them here would prove nothing either way.
// Reading the raw text is what actually pins "this module does not start
// its own loop", independent of environment.
//
// demo.js's own requestAnimationFrame (a bounded poll-until-`e.phase ===
// 'done'`, not an ambient per-frame effect) and blamecard.js's (one-shot
// next-paint kicks for a CSS width transition, not a loop) are out of
// scope on purpose — neither is one of the six.
const MODULES: [string, string][] = [
  ['ghost.js', ghostSrc],
  ['interact.js', interactSrc],
  ['gitsignals.js', gitsignalsSrc],
  ['histshelf.js', histshelfSrc],
]

describe('office frame loop — one rAF, driven from office.html', () => {
  it.each(MODULES)('%s never calls requestAnimationFrame itself', (_name, src) => {
    expect(src).not.toContain('requestAnimationFrame(')
  })
})
