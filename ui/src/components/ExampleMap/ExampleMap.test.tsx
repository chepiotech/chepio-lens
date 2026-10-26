// Core
import { renderToString } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
// Components
import ExampleMap from './ExampleMap'
import DetailsPanel from '../DetailsPanel/DetailsPanel'
// Utils
import { exampleCatalog, exampleGraph } from '../../map/exampleGraph'

describe('example architecture', () => {
  it('removes the header and introductory copy while keeping accessible map content', () => {
    const html = renderToString(<ExampleMap />)
    for (const text of ['Notes web', 'Notes API', 'Redis', 'PostgreSQL', '/settings', '/api/notes']) {
      expect(html).toContain(text)
    }
    expect(html).toContain('aria-label="Zoom in"')
    expect(html).toContain('aria-label="Console"')
    expect(html).toContain('aria-label="Settings"')
    for (const text of ['<header', 'Inside a request', 'A web app, its API', 'Illustrative pages', 'Data call', 'Cache access']) {
      expect(html).not.toContain(text)
    }
    expect(html).toMatch(/<footer class="chepio-footer">.*<\/footer><\/div>$/)
  })

  it('shows all endpoints and identifies Redis as cache', () => {
    const html = renderToString(<DetailsPanel graph={exampleGraph} catalog={exampleCatalog}
      selection={{ kind: 'node', id: 'example:api' }} onClose={() => {}} />)
    expect(html).toContain('/healthz')
    expect(html).toContain('Observed endpoints')
    const cache = renderToString(<DetailsPanel graph={exampleGraph} selection={{ kind: 'node', id: 'example:cache' }} onClose={() => {}} />)
    expect(cache).toContain('Cache')
    expect(cache).toContain('notes:list')
  })
})
