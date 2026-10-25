// Core
import { describe, expect, it } from 'vitest'
// Types
import type { LogEntryView } from '../api/generated/LogEntryView'
// Utils
import { DEFAULT_FILTERS, LOG_VIEW_LIMIT, logQuery, mergeLogEntries } from './logState'

const entry = (seq: number, time = '1792930000000000000'): LogEntryView => ({
  id: `${time}.${seq}`, time, trace_id: '1'.repeat(32), span_id: '1'.repeat(16), duration_ms: 1,
  layer: 'frontend', kind: 'request', service: 'web', nodes: ['svc:web'], text: `GET /${seq}`, status_code: 200, error: false, level: null, record: null,
})

describe('log window', () => {
  it('deduplicates overlapping pages and orders nanoseconds and sequence numbers exactly', () => {
    const newer = entry(1, '1792930000000000001')
    const result = mergeLogEntries([entry(2), newer], [entry(10), entry(2), entry(1)], 'newest')
    expect(result.map((item) => item.id)).toEqual([entry(1).id, entry(2).id, entry(10).id, newer.id])
  })

  it('bounds live and older windows in the direction the reader requested', () => {
    const all = Array.from({ length: LOG_VIEW_LIMIT + 10 }, (_, index) => entry(index))
    const live = mergeLogEntries([], all, 'newest')
    const older = mergeLogEntries([], all, 'oldest')
    expect(live).toHaveLength(LOG_VIEW_LIMIT)
    expect(older).toHaveLength(LOG_VIEW_LIMIT)
    expect(live[0]?.id).toBe(entry(10).id)
    expect(older[0]?.id).toBe(entry(0).id)
    expect(older.at(-1)?.id).toBe(entry(LOG_VIEW_LIMIT - 1).id)
  })

  it('encodes combined filters without confusing SQL and URL punctuation with query parameters', () => {
    const query = new URLSearchParams(logQuery({ ...DEFAULT_FILTERS, layers: ['frontend', 'database'], node: 'svc:web',
      edge: 'svc:web->svc:api', status: 'error', level: 'error', kind: 'log', text: ' x & y=1 ' }))
    expect(Object.fromEntries(query)).toEqual({ layer: 'frontend,database', node: 'svc:web', edge: 'svc:web->svc:api', status: 'error', level: 'error', kind: 'log', q: 'x & y=1' })
    expect(logQuery(DEFAULT_FILTERS)).toBe('')
  })
})
