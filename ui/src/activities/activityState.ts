// Types
import type { ActivityView } from '../api/generated/ActivityView'
import type { StepKindView } from '../api/generated/StepKindView'
import type { LogFilters } from '../logs/logState'
// Utils
import { LAYERS } from '../logs/logState'

/** Activities kept in the panel; the oldest leave first. */
export const ACTIVITY_VIEW_LIMIT = 500

export type LogsView = 'actions' | 'lines'
const VIEW_KEY = 'chepio-lens.logs-view'

/** Query of `GET /api/activities`: the panel's filters without `level` and `kind`, which belong to lines. */
export function activityQuery(filters: LogFilters): string {
  const query = new URLSearchParams()
  if (filters.layers.length < LAYERS.length) query.set('layer', filters.layers.join(','))
  if (filters.node) query.set('node', filters.node)
  if (filters.edge) query.set('edge', filters.edge)
  if (filters.status) query.set('status', filters.status)
  if (filters.origin) query.set('origin', filters.origin)
  if (filters.text.trim()) query.set('q', filters.text.trim())
  return query.toString()
}

/** By the cursor `<time_ns>.<seq>`, compared exactly: neither part fits safely in a floating-point number. */
export function compareActivities(a: ActivityView, b: ActivityView): number {
  const [timeA = '0', seqA = '0'] = a.cursor.split('.')
  const [timeB = '0', seqB = '0'] = b.cursor.split('.')
  const time = BigInt(timeA) - BigInt(timeB)
  if (time !== 0n) return time < 0n ? -1 : 1
  const seq = BigInt(seqA) - BigInt(seqB)
  return seq < 0n ? -1 : seq > 0n ? 1 : 0
}

/**
 * Oldest first, newest at the bottom as in the lines view. A newer copy of an activity replaces the older one, also
 * when its time moved (the action's record arrived after its spans); `removed`: activities merged into others.
 */
export function mergeActivities(previous: ActivityView[], incoming: ActivityView[], removed: ReadonlySet<string>, keep: 'newest' | 'oldest'): ActivityView[] {
  const byId = new Map(previous.map((activity) => [activity.id, activity]))
  for (const activity of incoming) byId.set(activity.id, activity)
  for (const id of removed) byId.delete(id)
  const sorted = [...byId.values()].sort(compareActivities)
  return keep === 'newest' ? sorted.slice(-ACTIVITY_VIEW_LIMIT) : sorted.slice(0, ACTIVITY_VIEW_LIMIT)
}

/** What happened at a step, as a reader says it. */
export const STEP_WORDS: Record<StepKindView, string> = {
  action: 'User action',
  send: 'Request sent',
  receive: 'Request received',
  query: 'Query sent',
  result: 'Database answered',
  respond: 'Response sent',
  response: 'Response received',
  span: 'Span',
  log: 'Log',
}

/** Out to the callee, back to the caller, or at one place. */
export const STEP_DIRECTION: Record<StepKindView, 'out' | 'back' | 'here'> = {
  action: 'here',
  send: 'out',
  receive: 'out',
  query: 'out',
  result: 'back',
  respond: 'back',
  response: 'back',
  span: 'here',
  log: 'here',
}

/** `+12.3 ms` from the activity's start; negative across processes whose clocks differ (I12). */
export function formatOffset(ms: number): string {
  const sign = ms < 0 ? '−' : '+'
  const magnitude = Math.abs(ms)
  return `${sign}${magnitude >= 100 ? Math.round(magnitude).toLocaleString('en-US') : magnitude.toFixed(1)} ms`
}

export function readLogsView(): LogsView {
  try {
    return localStorage.getItem(VIEW_KEY) === 'lines' ? 'lines' : 'actions'
  } catch {
    return 'actions'
  }
}

export function saveLogsView(view: LogsView) {
  try { localStorage.setItem(VIEW_KEY, view) } catch { /* Storage may be disabled; the view still switches. */ }
}
