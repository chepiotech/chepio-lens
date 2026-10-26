// Types
import type { GraphView } from './generated/GraphView'
import type { LensEventName } from './generated/LensEventName'
import type { LogPageView } from './generated/LogPageView'
import type { RequestDetailView } from './generated/RequestDetailView'

export const EVENTS_URL = '/api/events'

/** SSE event names, checked against the generated type so a rename in Rust fails the type check. */
export const EVENT = {
  node: 'node',
  edge: 'edge',
  request: 'request',
  log: 'log',
  activity: 'activity',
  resync: 'resync',
} as const satisfies Record<LensEventName, LensEventName>

export async function fetchGraph(): Promise<GraphView> {
  const response = await fetch('/api/graph')
  if (!response.ok) throw new Error(`GET /api/graph failed with ${response.status}`)
  return response.json()
}

export async function resetCollector(): Promise<void> {
  const response = await fetch('/api/reset', { method: 'POST' })
  if (!response.ok) throw new Error(`POST /api/reset failed with ${response.status}`)
}

export async function fetchLogs(query: string, before?: string, signal?: AbortSignal): Promise<LogPageView> {
  const params = new URLSearchParams(query)
  params.set('limit', '500')
  if (before) params.set('before', before)
  const response = await fetch(`/api/logs?${params}`, { signal })
  if (!response.ok) throw new Error('Could not load logs. Check the collector connection and retry.')
  return response.json()
}

export async function fetchRequest(traceId: string, signal?: AbortSignal): Promise<RequestDetailView> {
  const response = await fetch(`/api/requests/${encodeURIComponent(traceId)}`, { signal })
  if (response.status === 404) throw new Error('This request is no longer available. Choose another log line.')
  if (!response.ok) throw new Error('Could not load this request. Check the collector connection and retry.')
  return response.json()
}
