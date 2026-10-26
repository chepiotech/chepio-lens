// Core
import { renderToString } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
// Components
import DetailsPanel from './DetailsPanel'
// Types
import type { EdgeView } from '../../api/generated/EdgeView'
import type { NodeView } from '../../api/generated/NodeView'

it('renders SDK page paths and microfrontend names as text, including markup-like labels', () => {
  const node: NodeView = { id: 'web', label: 'Web', kind: 'frontend', db_system: null,
    address: null, port: null, namespace: null, first_seen: '0', last_seen: '0',
    metadata: { technologies: ['react'], pages: ['/'], microfrontends: [
      { name: '<img src=x onerror=alert(1)>', framework: 'react', pages: ['/<script>alert(1)</script>'] },
    ] },
  }
  const html = renderToString(<DetailsPanel graph={{ nodes: { web: node }, edges: {} }}
    selection={{ kind: 'node', id: 'web' }} onClose={() => {}} />)
  expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;')
  expect(html).toContain('/&lt;script&gt;alert(1)&lt;/script&gt;')
  expect(html).not.toContain('<img')
  expect(html).not.toContain('<script')
})

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
