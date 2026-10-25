// Core
import { describe, expect, it } from 'vitest'
// Utils
import { MAX_REQUEST_MS, MIN_HOP_MS, pulsesFor } from './requestPulses'

const hop = (edge: string, start_offset_ms: number, duration_ms: number) => ({ edge, start_offset_ms, duration_ms })

describe('pulsesFor', () => {
  it('stretches a fast request until its shortest hop is visible, keeping order and overlap', () => {
    // Browser fetch 30 ms; the query starts 5 ms in and takes 4 ms.
    const pulses = pulsesFor([hop('web->api', 0, 30), hop('api->db', 5, 4)])

    const scale = MIN_HOP_MS / 4
    expect(pulses).toEqual([
      { edgeId: 'web->api', delayMs: 0, durationMs: 30 * scale },
      { edgeId: 'api->db', delayMs: 5 * scale, durationMs: MIN_HOP_MS },
    ])
    expect(pulses[1]!.delayMs + pulses[1]!.durationMs).toBeLessThan(pulses[0]!.durationMs)
  })

  it('compresses a slow request to the maximum and holds hops that became too short', () => {
    const pulses = pulsesFor([hop('web->api', 0, 6_000), hop('api->db', 1_000, 1)])

    expect(pulses[0]!.durationMs).toBe(MAX_REQUEST_MS)
    expect(pulses[1]).toEqual({ edgeId: 'api->db', delayMs: 500, durationMs: MIN_HOP_MS })
  })

  it('handles empty requests and zero durations', () => {
    expect(pulsesFor([])).toEqual([])
    expect(pulsesFor([hop('a->b', 0, 0)])).toEqual([{ edgeId: 'a->b', delayMs: 0, durationMs: MIN_HOP_MS }])
  })
})
