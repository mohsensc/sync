import { describe, expect, it } from 'vitest'
import officeSource from '../src/office/office.html?raw'

describe('production office starts empty', () => {
  it('does not import or expose the scripted demo', () => {
    expect(officeSource).not.toContain("from './demo.js'")
    expect(officeSource).not.toContain('id="bDemo"')
    expect(officeSource).not.toContain('startDemo()')
    expect(officeSource).not.toContain('goDemoFallback')
  })

  it('does not create static agents or generated activity', () => {
    expect(officeSource).not.toContain('AGENT_CAST')
    expect(officeSource).not.toContain('BACKGROUND')
    expect(officeSource).not.toContain('SAMPLE_EVENTS')
    expect(officeSource).not.toContain('seedEvents()')
    expect(officeSource).not.toContain('attachCommitBoard')
    expect(officeSource).toContain('const reelStore = new ReelStore([])')
  })

  it('keeps an unavailable or unselected room visibly empty', () => {
    expect(officeSource).toContain("goEmpty('no repository selected')")
    expect(officeSource).toContain("setMode('empty', `empty · ${reason}`)")
    expect(officeSource).toContain("mode: () => (liveMode ? 'live' : 'empty')")
  })
})
