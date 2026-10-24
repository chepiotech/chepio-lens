// Core
import { describe, expect, it } from 'vitest'
// Types
import type { EdgeView } from '../api/generated/EdgeView'
import type { NodeView } from '../api/generated/NodeView'
// Utils
import { emptyGraph, graphReducer } from './graphState'

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
  p50_ms: 1,
  p95_ms: 2,
  rate_per_s: 0.5,
  last_seen: '2',
})

describe('graphReducer', () => {
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
