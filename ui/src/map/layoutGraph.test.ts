// Core
import { describe, expect, it } from 'vitest'
// Types
import type { EdgeView } from '../api/generated/EdgeView'
import type { NodeView } from '../api/generated/NodeView'
// Utils
import { layoutGraph } from './layoutGraph'

const node = (id: string, kind: NodeView['kind']): NodeView => ({
  id,
  kind,
  label: id,
  db_system: null,
  address: null,
  port: null,
  namespace: null,
  first_seen: '0',
  last_seen: '0',
})

const edge = (from: string, to: string, protocol: EdgeView['protocol'] = 'http'): EdgeView => ({
  id: `${from}->${to}`,
  from,
  to,
  protocol,
  count: 1,
  errors: 0,
  last_error: false,
  last_duration_ms: 0.06,
  p50_ms: 1,
  p95_ms: 1,
  rate_per_s: 0,
  routes: [],
  last_seen: '0',
})

const nodes = [
  node('svc:web', 'frontend'),
  node('svc:api', 'service'),
  node('svc:payments', 'service'),
  node('db:postgresql', 'database'),
  node('ext:bank', 'external'),
]
const edges = [
  edge('svc:web', 'svc:api'),
  edge('svc:api', 'svc:payments'),
  edge('svc:api', 'db:postgresql', 'db'),
  edge('svc:payments', 'ext:bank'),
]

describe('layoutGraph', () => {
  it('puts kinds in columns and orders services by call depth', () => {
    const x = (id: string) => layoutGraph(nodes, edges).get(id)?.x
    expect(x('svc:web')).toBeLessThan(x('svc:api')!)
    expect(x('svc:api')).toBeLessThan(x('svc:payments')!)
    expect(x('svc:payments')).toBeLessThan(x('db:postgresql')!)
    expect(x('db:postgresql')).toBeLessThan(x('ext:bank')!)
  })

  it('gives the same graph the same positions whatever the input order', () => {
    const shuffled = layoutGraph([...nodes].reverse(), [...edges].reverse())
    expect(shuffled).toEqual(layoutGraph(nodes, edges))
  })

  it('keeps existing nodes in place when a node joins another column', () => {
    const before = layoutGraph(nodes.slice(1, 4), edges.slice(1, 3))
    const after = layoutGraph([...nodes.slice(1, 4), node('ext:bank', 'external')], edges.slice(1, 3))
    for (const id of ['svc:api', 'svc:payments', 'db:postgresql']) {
      expect(after.get(id)).toEqual(before.get(id))
    }
  })

  it('stacks nodes of one column by id, centered on y = 0', () => {
    const positions = layoutGraph([node('svc:b', 'service'), node('svc:a', 'service')], [])
    expect(positions.get('svc:a')!.y).toBeLessThan(positions.get('svc:b')!.y)
    expect(positions.get('svc:a')!.y + positions.get('svc:b')!.y).toBe(0)
  })

  it('survives a call cycle between services', () => {
    const cycle = [edge('svc:a', 'svc:b'), edge('svc:b', 'svc:a')]
    const positions = layoutGraph([node('svc:a', 'service'), node('svc:b', 'service')], cycle)
    expect(positions.size).toBe(2)
  })
})
