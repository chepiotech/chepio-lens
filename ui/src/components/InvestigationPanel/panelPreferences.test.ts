// Core
import { afterEach, describe, expect, it, vi } from 'vitest'
// Utils
import { PANEL_DEFAULTS, readPanelPreferences, savePanelPreferences } from './panelPreferences'

afterEach(() => vi.unstubAllGlobals())

describe('panel preferences', () => {
  it('restores the dock and constrains corrupt sizes', () => {
    vi.stubGlobal('localStorage', { getItem: () => '{"dock":"bottom","width":-5,"height":99999}' })
    expect(readPanelPreferences()).toEqual({ dock: 'bottom', width: 340, height: 800 })
  })

  it('works when storage is denied or contains invalid JSON', () => {
    vi.stubGlobal('localStorage', { getItem: () => '{invalid', setItem: () => { throw new Error('denied') } })
    expect(readPanelPreferences()).toEqual(PANEL_DEFAULTS)
    expect(() => savePanelPreferences(PANEL_DEFAULTS)).not.toThrow()
  })
})
