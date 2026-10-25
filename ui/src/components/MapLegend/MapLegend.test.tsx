// Core
import { renderToString } from 'react-dom/server'
import { afterEach, describe, expect, it, vi } from 'vitest'
// Components
import MapLegend from './MapLegend'
// Utils
import { LEGEND } from '../../map/packets'
import { readLegendOpen, saveLegendOpen } from './legendPreference'

afterEach(() => vi.unstubAllGlobals())

const memoryStorage = () => {
  const values = new Map<string, string>()
  return { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => void values.set(key, value) }
}

describe('MapLegend', () => {
  it('explains every packet and flash icon, drawn as SVG paths without injected markup', () => {
    vi.stubGlobal('localStorage', memoryStorage())
    saveLegendOpen(true)
    const html = renderToString(<MapLegend />)

    for (const { text } of LEGEND) expect(html).toContain(text)
    expect(html.match(/<li /g)).toHaveLength(LEGEND.length)
    expect(html.match(/class="map-legend__icon"/g)).toHaveLength(LEGEND.length)
    // Only the HTTPS sample carries the lock badge.
    expect(html.match(/class="map-legend__badge"/g)).toHaveLength(1)
    expect(html).toContain('<path d="M6 22a2 2 0 0 1-2-2V4')
    expect(html).toMatch(/<details class="map-legend" open=""/)
  })

  it('starts closed, so it never covers the map, and stays open once opened', () => {
    vi.stubGlobal('localStorage', memoryStorage())
    expect(readLegendOpen()).toBe(false)
    expect(renderToString(<MapLegend />)).not.toContain('open=""')

    saveLegendOpen(true)

    expect(readLegendOpen()).toBe(true)
    expect(renderToString(<MapLegend />)).toContain('open=""')
  })

  it('works without storage', () => {
    vi.stubGlobal('localStorage', { getItem: () => { throw new Error('blocked') }, setItem: () => { throw new Error('blocked') } })

    expect(readLegendOpen()).toBe(false)
    expect(() => saveLegendOpen(true)).not.toThrow()
  })
})
