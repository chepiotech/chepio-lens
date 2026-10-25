// Core
import { renderToString } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
// Components
import DetailsPanel from './DetailsPanel'
// Types
import type { EdgeView } from '../../api/generated/EdgeView'

describe('edge details', () => {
  it('distinguishes the successful last call from earlier session errors and latency', () => {
    const edge: EdgeView = {
      id: 'svc:web->svc:api', from: 'svc:web', to: 'svc:api', protocol: 'http',
      count: 2, errors: 1, last_error: false, last_duration_ms: 0.06,
      p50_ms: 0.064, p95_ms: 741.4552, rate_per_s: 0.1, routes: [], last_seen: '1',
    }
    const html = renderToString(<DetailsPanel
      graph={{ nodes: {}, edges: { [edge.id]: edge } }}
      selection={{ kind: 'edge', id: edge.id }}
      onClose={() => {}}
    />)
    expect(html).toContain('<dt>Last call</dt><dd>Success</dd>')
    expect(html).toContain('<dt>Last duration</dt><dd>0.06 ms</dd>')
    expect(html).toContain('<dt>Errors this session</dt><dd>1</dd>')
    expect(html).toContain('<dt>Session p95 (approx.)</dt><dd>741 ms</dd>')
  })
})
