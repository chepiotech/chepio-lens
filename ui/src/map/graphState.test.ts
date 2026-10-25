// Core
import { describe, expect, it } from 'vitest'
// Types
import type { EdgeView } from '../api/generated/EdgeView'
import type { NodeView } from '../api/generated/NodeView'
// Utils
import { emptyGraph, graphReducer, mergeGraphSnapshot } from './graphState'

const api: NodeView = {
  id: 'svc:api',
  kind: 'service',
  label: 'api',
  db_system: null,
  address: null,
  port: null,
  namespace: null,
  first_seen: '1',
  last_seen: '1',
}
const edge = (count: number): EdgeView => ({
  id: 'svc:api->db:x',
  from: 'svc:api',
  to: 'db:x',
  protocol: 'db',
  count,
  errors: 0,
  last_error: false,
  last_duration_ms: 0.06,
  p50_ms: 1,
  p95_ms: 2,
  rate_per_s: 0.5,
  routes: [],
  last_seen: '2',
})

describe('graphReducer', () => {
  it('does not restore a snapshot error over success received while it was loading', () => {
    const failure = { ...edge(1), errors: 1, last_error: true, last_duration_ms: 700 }
    const success = { ...edge(2), errors: 1 }
    const graph = mergeGraphSnapshot(
      { nodes: [api], edges: [failure], generated_at: '3' },
      { nodes: { [api.id]: { ...api, last_seen: '4' } }, edges: { [success.id]: success } },
    )
    expect(graph.edges).toEqual([success])
    expect(graph.nodes[0]?.last_seen).toBe('4')
  })

  it('does not overwrite a snapshot that already includes newer calls with earlier buffered events', () => {
    const latest = { ...edge(3), last_error: true }
    const graph = mergeGraphSnapshot(
      { nodes: [api], edges: [latest], generated_at: '3' },
      { nodes: {}, edges: { [latest.id]: edge(2) } },
    )
    expect(graph.edges).toEqual([latest])
    expect(mergeGraphSnapshot({ nodes: [], edges: [], generated_at: '4' }, emptyGraph).edges).toEqual([])
  })

  it('applies a snapshot, then upserts nodes and edges from events', () => {
    let state = graphReducer(emptyGraph, { type: 'snapshot', graph: { nodes: [api], edges: [edge(1)], generated_at: '3' } })
    state = graphReducer(state, { type: 'edge', edge: edge(2) })
    state = graphReducer(state, { type: 'node', node: { ...api, id: 'svc:web', kind: 'frontend' } })

    expect(state.edges['svc:api->db:x']?.count).toBe(2)
    expect(Object.keys(state.nodes).sort()).toEqual(['svc:api', 'svc:web'])
  })

  it('a later snapshot replaces stale state and clear empties it', () => {
    const stale = graphReducer(emptyGraph, { type: 'node', node: api })
    const fresh = graphReducer(stale, { type: 'snapshot', graph: { nodes: [], edges: [], generated_at: '4' } })
    expect(fresh.nodes).toEqual({})
    expect(graphReducer(stale, { type: 'clear' })).toBe(emptyGraph)
  })
})
