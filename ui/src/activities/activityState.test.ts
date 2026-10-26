// Core
import { afterEach, describe, expect, it, vi } from 'vitest'
// Types
import type { ActivityView } from '../api/generated/ActivityView'
// Utils
import { DEFAULT_FILTERS } from '../logs/logState'
import {
  ACTIVITY_VIEW_LIMIT, activityQuery, formatOffset, mergeActivities, readLogsView, saveLogsView, STEP_DIRECTION, STEP_WORDS,
} from './activityState'

afterEach(() => vi.unstubAllGlobals())

const activity = (id: string, cursor: string, title = id): ActivityView => ({
  id, cursor, origin: 'action', title, time: cursor.split('.')[0]!, service: 'web', duration_ms: 1, layers: ['frontend'],
  services: ['web'], nodes: ['svc:web'], traces: [], traces_unlisted: 0, lines: 1, error: false, status_code: null,
})

describe('activity window', () => {
  it('orders by nanoseconds and arrival exactly and keeps the newer copy of an activity', () => {
    const result = mergeActivities(
      [activity('action:b', '1792930000000000001.5', 'old title'), activity('action:a', '1792930000000000000.9')],
      [activity('action:b', '1792930000000000001.5', 'new title'), activity('trace:c', '1792930000000000000.10')],
      new Set(),
      'newest',
    )
    expect(result.map((item) => item.id)).toEqual(['action:a', 'trace:c', 'action:b'])
    expect(result[2]!.title).toBe('new title')
  })

  it('drops activities merged into an action and moves one whose time changed', () => {
    const trace = activity('trace:t', '1792930000000000005.1')
    const action = activity('action:x', '1792930000000000004.0')
    const result = mergeActivities([trace, activity('action:x', '1792930000000000009.0')], [action], new Set(['trace:t']), 'newest')
    expect(result).toEqual([action])
  })

  it('bounds the window in the direction the reader asked for', () => {
    const many = Array.from({ length: ACTIVITY_VIEW_LIMIT + 3 }, (_, n) => activity(`trace:${n}`, `1792930000000000000.${n}`))
    expect(mergeActivities([], many, new Set(), 'newest')[0]!.id).toBe('trace:3')
    expect(mergeActivities([], many, new Set(), 'oldest').at(-1)!.id).toBe(`trace:${ACTIVITY_VIEW_LIMIT - 1}`)
  })
})

describe('activity query and steps', () => {
  it('sends the shared filters and the origin, but not the line-only level and kind', () => {
    expect(activityQuery({ ...DEFAULT_FILTERS, layers: ['database'], status: 'error', level: 'warn', kind: 'query', origin: 'action', text: ' notes ' }))
      .toBe('layer=database&status=error&origin=action&q=notes')
    expect(activityQuery(DEFAULT_FILTERS)).toBe('')
  })

  it('names every step kind and its direction, there and back', () => {
    expect(Object.keys(STEP_WORDS)).toEqual(Object.keys(STEP_DIRECTION))
    expect([STEP_DIRECTION.send, STEP_DIRECTION.query, STEP_DIRECTION.result, STEP_DIRECTION.response]).toEqual(['out', 'out', 'back', 'back'])
    expect(formatOffset(12.34)).toBe('+12.3 ms')
    expect(formatOffset(-9_998.2)).toBe('−9,998 ms')
  })

  it('remembers the view and falls back to actions without storage', () => {
    const values = new Map<string, string>()
    vi.stubGlobal('localStorage', { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => void values.set(key, value) })
    expect(readLogsView()).toBe('actions')
    saveLogsView('lines')
    expect(readLogsView()).toBe('lines')
    vi.stubGlobal('localStorage', { getItem: () => { throw new Error('blocked') }, setItem: () => { throw new Error('blocked') } })
    expect(readLogsView()).toBe('actions')
    expect(() => saveLogsView('lines')).not.toThrow()
  })
})
