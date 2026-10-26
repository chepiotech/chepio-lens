// Core
import { describe, expect, it } from 'vitest'
// Types
import type { PacketView } from '../api/generated/PacketView'
// Utils
import { MAX_REQUEST_MS, MIN_HOP_MS, MIN_TRAVEL_SHARE, TRAVEL_SHARE, pulsesFor } from './requestPulses'

const packet: PacketView = {
  kind: 'http', operation: 'GET', request_body: 'none', response_body: 'json', rpc_status: null, status_code: 200, error: false,
}
const hop = (edge: string, start_offset_ms: number, duration_ms: number, hopPacket: PacketView | null = null) =>
  ({ edge, start_offset_ms, duration_ms, packet: hopPacket })

describe('pulsesFor', () => {
  it('stretches a fast request until its shortest hop is visible, keeping order and overlap', () => {
    // Browser fetch 30 ms; the query starts 5 ms in and takes 4 ms.
    const pulses = pulsesFor([hop('web->api', 0, 30, packet), hop('api->db', 5, 4)])

    const scale = Math.min(MIN_HOP_MS / 4, MAX_REQUEST_MS / 30)
    expect(pulses.map(({ edgeId, delayMs, durationMs, packet: carried }) => ({ edgeId, delayMs, durationMs, carried }))).toEqual([
      { edgeId: 'web->api', delayMs: 0, durationMs: 30 * scale, carried: packet },
      { edgeId: 'api->db', delayMs: 5 * scale, durationMs: MIN_HOP_MS, carried: null },
    ])
    expect(pulses[1]!.delayMs + pulses[1]!.durationMs).toBeLessThan(pulses[0]!.durationMs)
  })

  it('lets the request arrive before the callee calls on, and the response leave after those calls end', () => {
    const [outer, inner] = pulsesFor([hop('web->api', 0, 30), hop('api->db', 5, 4)])

    // The query starts 5 ms into a 30 ms hop and ends 21 ms before it.
    expect(outer!.outbound).toBeCloseTo(5 / 30)
    expect(outer!.outbound * outer!.durationMs).toBeLessThanOrEqual(inner!.delayMs)
    expect(outer!.inbound).toBe(1 - TRAVEL_SHARE)
    expect(outer!.inbound * outer!.durationMs).toBeGreaterThanOrEqual(inner!.delayMs + inner!.durationMs)
    // A hop with no calls inside travels for the longest share each way.
    expect([inner!.outbound, inner!.inbound]).toEqual([TRAVEL_SHARE, 1 - TRAVEL_SHARE])
  })

  it('still moves the request when the callee calls on at once', () => {
    const [outer] = pulsesFor([hop('web->api', 0, 100), hop('api->db', 0.1, 99.8)])

    expect([outer!.outbound, outer!.inbound]).toEqual([MIN_TRAVEL_SHARE, 1 - MIN_TRAVEL_SHARE])
  })

  it('compresses a slow request to the maximum and holds hops that became too short', () => {
    const pulses = pulsesFor([hop('web->api', 0, 6_000), hop('api->db', 1_000, 1)])

    expect(pulses[0]!.durationMs).toBe(MAX_REQUEST_MS)
    expect(pulses[1]).toMatchObject({ edgeId: 'api->db', delayMs: 500, durationMs: MIN_HOP_MS })
  })

  it('handles empty requests and zero durations', () => {
    expect(pulsesFor([])).toEqual([])
    expect(pulsesFor([hop('a->b', 0, 0)])).toEqual([
      { edgeId: 'a->b', delayMs: 0, durationMs: MIN_HOP_MS, packet: null, outbound: TRAVEL_SHARE, inbound: 1 - TRAVEL_SHARE },
    ])
  })
})
