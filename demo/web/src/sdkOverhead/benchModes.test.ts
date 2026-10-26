// Core
import { describe, expect, it } from 'vitest'
// Domain
import { isMode, lensOptions, SERVICE_NAME } from './benchModes'

describe('bench modes', () => {
  it('loads no SDK when off and turns bodies off only in the spans mode', () => {
    const endpoint = 'http://127.0.0.1:34318'

    expect(lensOptions('off', endpoint)).toBeNull()
    expect(lensOptions('spans', endpoint)).toEqual({ serviceName: SERVICE_NAME, endpoint, captureBodies: false })
    expect(lensOptions('bodies', endpoint)).toEqual({ serviceName: SERVICE_NAME, endpoint, captureBodies: true })
    expect(lensOptions('unreachable', endpoint)?.captureBodies).toBe(true)
  })

  it('accepts only the known modes from the page URL', () => {
    expect(isMode('bodies')).toBe(true)
    expect(isMode('noop')).toBe(false)
    expect(isMode(null)).toBe(false)
  })
})
