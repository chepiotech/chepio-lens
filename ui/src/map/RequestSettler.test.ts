// Core
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
// Utils
import { MAX_PENDING, RequestSettler, SETTLE_WITH_ROOT_MS, SETTLE_WITHOUT_ROOT_MS } from './RequestSettler'
// Types
import type { RequestView } from '../api/generated/RequestView'

function request(traceId: string, hasRoot: boolean, edges: string[]): RequestView {
  return {
    trace_id: traceId,
    name: 'GET /api/notes',
    service: 'demo-web',
    method: 'GET',
    route: '/api/notes',
    status_code: 200,
    start: '0',
    duration_ms: 30,
    services: ['demo-web', 'demo-api'],
    error: false,
    span_count: edges.length + 1,
    dropped_spans: 0,
    has_root: hasRoot,
    hops: edges.map((edge) => ({ edge, start_offset_ms: 0, duration_ms: 1, packet: null })),
  }
}

describe('RequestSettler', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('hands a request over once, with the hops of its last event', () => {
    const settled = vi.fn()
    const settler = new RequestSettler(settled)

    // The API's batch arrives first (no root), the browser's batch 800 ms later.
    settler.push(request('t1', false, ['api->db']))
    vi.advanceTimersByTime(800)
    settler.push(request('t1', true, ['web->api', 'api->db']))
    vi.advanceTimersByTime(SETTLE_WITH_ROOT_MS - 1)
    expect(settled).not.toHaveBeenCalled()
    vi.advanceTimersByTime(1)

    expect(settled).toHaveBeenCalledTimes(1)
    expect(settled.mock.calls[0]![0].hops.map((hop: { edge: string }) => hop.edge)).toEqual(['web->api', 'api->db'])
    settler.push(request('t1', true, ['web->api', 'api->db']))
    vi.advanceTimersByTime(SETTLE_WITHOUT_ROOT_MS)
    expect(settled).toHaveBeenCalledTimes(1)
  })

  it('animates a request without a root after the longer wait', () => {
    const settled = vi.fn()
    const settler = new RequestSettler(settled)

    settler.push(request('t2', false, ['web->ext']))
    vi.advanceTimersByTime(SETTLE_WITHOUT_ROOT_MS - 1)
    expect(settled).not.toHaveBeenCalled()
    vi.advanceTimersByTime(1)
    expect(settled).toHaveBeenCalledTimes(1)
  })

  it('hands the oldest waiting request over early when too many wait', () => {
    const settled = vi.fn()
    const settler = new RequestSettler(settled)

    for (let i = 0; i <= MAX_PENDING; i += 1) settler.push(request(`t${i}`, true, ['a->b']))

    expect(settled).toHaveBeenCalledTimes(1)
    expect(settled.mock.calls[0]![0].trace_id).toBe('t0')
  })

  it('forgets everything on clear', () => {
    const settled = vi.fn()
    const settler = new RequestSettler(settled)
    settler.push(request('t3', true, ['a->b']))
    vi.advanceTimersByTime(SETTLE_WITH_ROOT_MS)
    settler.push(request('t4', true, ['a->b']))

    settler.clear()
    vi.advanceTimersByTime(SETTLE_WITHOUT_ROOT_MS)
    settler.push(request('t3', true, ['a->b']))
    vi.advanceTimersByTime(SETTLE_WITH_ROOT_MS)

    expect(settled.mock.calls.map((call) => call[0].trace_id)).toEqual(['t3', 't3'])
  })
})
