// Types
import type { GraphView } from './generated/GraphView'
import type { LensEventName } from './generated/LensEventName'

export const EVENTS_URL = '/api/events'

/** SSE event names, checked against the generated type so a rename in Rust fails the type check. */
export const EVENT = {
  node: 'node',
  edge: 'edge',
  request: 'request',
  log: 'log',
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
