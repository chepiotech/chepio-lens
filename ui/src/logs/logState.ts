// Types
import type { LayerView } from '../api/generated/LayerView'
import type { LogEntryView } from '../api/generated/LogEntryView'

export const LOG_VIEW_LIMIT = 2_000
export const LAYERS: LayerView[] = ['frontend', 'backend', 'database']
export type LogFilters = { layers: LayerView[]; node: string; edge: string; status: '' | 'ok' | 'error'; text: string }
export const DEFAULT_FILTERS: LogFilters = { layers: LAYERS, node: '', edge: '', status: '', text: '' }

export function logQuery(filters: LogFilters): string {
  const query = new URLSearchParams()
  if (filters.layers.length < LAYERS.length) query.set('layer', filters.layers.join(','))
  if (filters.node) query.set('node', filters.node)
  if (filters.edge) query.set('edge', filters.edge)
  if (filters.status) query.set('status', filters.status)
  if (filters.text.trim()) query.set('q', filters.text.trim())
  return query.toString()
}

/** Cursor contains nanoseconds and arrival sequence; neither fits safely in floating-point numbers. */
export function compareLogEntries(a: LogEntryView, b: LogEntryView): number {
  const time = BigInt(a.time) - BigInt(b.time)
  if (time !== 0n) return time < 0n ? -1 : 1
  const seqA = BigInt(a.id.split('.')[1] ?? '0')
  const seqB = BigInt(b.id.split('.')[1] ?? '0')
  return seqA < seqB ? -1 : seqA > seqB ? 1 : 0
}

export function mergeLogEntries(previous: LogEntryView[], incoming: LogEntryView[], keep: 'newest' | 'oldest'): LogEntryView[] {
  const byId = new Map(previous.map((entry) => [entry.id, entry]))
  for (const entry of incoming) byId.set(entry.id, entry)
  const sorted = [...byId.values()].sort(compareLogEntries)
  return keep === 'newest' ? sorted.slice(-LOG_VIEW_LIMIT) : sorted.slice(0, LOG_VIEW_LIMIT)
}

export function logTime(time: string): string {
  const date = new Date(Number(BigInt(time) / 1_000_000n))
  return `${date.toLocaleTimeString([], { hour12: false })}.${String(date.getMilliseconds()).padStart(3, '0')}`
}
