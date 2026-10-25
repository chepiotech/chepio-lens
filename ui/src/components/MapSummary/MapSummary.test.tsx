// Core
import { renderToString } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
// Components
import MapSummary from './MapSummary'
// Types
import type { EdgeView } from '../../api/generated/EdgeView'
import type { NodeView } from '../../api/generated/NodeView'

const node = (id: string, label: string, kind: NodeView['kind']): NodeView => ({
  id,
  kind,
  label,
  db_system: null,
  address: null,
  port: null,
  namespace: null,
  first_seen: '0',
  last_seen: '0',
})

const edge = (from: string, to: string, count: number, errors: number, p95_ms: number): EdgeView => ({
  id: `${from}->${to}`,
  from,
  to,
  protocol: 'http',
  count,
  errors,
  p50_ms: p95_ms,
  p95_ms,
  rate_per_s: 0,
  last_seen: '0',
})

describe('MapSummary', () => {
  it('lists every node and every edge with its numbers, as text', () => {
    const graph = {
      nodes: {
        'svc:api': node('svc:api', 'demo-api', 'service'),
        'svc:web': node('svc:web', 'demo-web', 'frontend'),
        'db:pg': node('db:pg', 'postgresql demo', 'database'),
      },
      edges: {
        'svc:web->svc:api': edge('svc:web', 'svc:api', 1, 0, 371.4),
        'svc:api->db:pg': edge('svc:api', 'db:pg', 3, 1, 4.25),
      },
    }

    const html = renderToString(<MapSummary graph={graph} />)

    expect(html).toContain('aria-label="Map as text"')
    expect(html).toContain('demo-web (frontend)')
    expect(html).toContain('demo-api → postgresql demo: 3 calls, 1 errors, p95 4.3 ms')
    expect(html).toContain('demo-web → demo-api: 1 call, 0 errors, p95 371 ms')
    expect(html.indexOf('demo-api → postgresql demo')).toBeLessThan(html.indexOf('demo-web → demo-api'))
  })
})
