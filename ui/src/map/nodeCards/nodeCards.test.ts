// Core
import { describe, expect, it } from 'vitest'
// Types
import type { LogEntryView } from '../../api/generated/LogEntryView'
import type { NodeCatalog } from './nodeCards'
// Utils
import { exampleCatalog, exampleGraph } from '../exampleGraph'
import { MAX_PAGES, MAX_PAGE_NODES, nodeCard, nodeKind, observePage } from './nodeCards'

const nodes = exampleGraph.nodes
const edges = Object.values(exampleGraph.edges)
const navigation = (path: string): LogEntryView => ({
  id: '1', trace_id: null, span_id: null, time: '0', duration_ms: null, layer: 'frontend', kind: 'action',
  service: 'web', nodes: ['example:web'], text: `navigate ${path}`, status_code: null, error: false, level: null,
  record: { body: `navigate ${path}`, attributes: [{ key: 'url.path', kind: 'string', values: [path] }], truncated: false },
})

describe('node cards', () => {
  it('recognizes Redis telemetry without guessing from the label or changing the database wire kind', () => {
    const redis = { ...nodes['example:cache']!, label: 'session-store', db_system: 'redis' }
    expect(redis.kind).toBe('database')
    expect(nodeKind(redis)).toBe('cache')
    const card = nodeCard(redis, edges)
    expect(card.technologies).toEqual(['redis'])
    expect(card.role).toBe('Cache')
    expect(card.rows.map((row) => row.tag)).toEqual(['GET', 'DEL', 'SET'])
    expect(nodeKind({ ...redis, kind: 'service', label: 'redis' })).toBe('service')
  })

  it('aggregates incoming endpoints across callers and excludes downstream database operations', () => {
    const duplicate = { ...edges[0]!, id: 'another', from: 'another-web' }
    const card = nodeCard(nodes['example:api']!, [...edges, duplicate])
    expect(card.rows[0]).toEqual({ tag: 'GET', label: '/api/notes', count: 256 })
    expect(card.rows).toHaveLength(5)
    expect(card.rows.some((row) => row.tag === 'SELECT')).toBe(false)
    expect(card.technologies).toEqual([])
  })

  it('never treats API destinations as pages or infers React from frontend kind', () => {
    const card = nodeCard(nodes['example:web']!, edges)
    expect(card.rows).toEqual([])
    expect(card.technologies).toEqual([])
    const populated = nodeCard(nodes['example:web']!, edges, exampleCatalog['example:web'])
    expect(populated.rows.map((row) => row.label)).toEqual(['/', '/notes', '/notes/:id', '/settings'])
    expect(populated.technologies).toEqual(['react', 'vue'])
  })

  it('has sensible unknown/external/empty fallbacks and recognizes PostgreSQL', () => {
    expect(nodeCard(nodes['example:postgres']!, edges).technologies).toEqual(['postgresql'])
    const node = { ...nodes['example:api']!, kind: 'external' as const, label: 'api.vendor.test' }
    expect(nodeCard(node, []).role).toBe('External')
    expect(nodeCard(node, []).rows).toEqual([])
  })

  it('shows the backend stack but restricts frontends to frameworks, with expanding microfrontend groups', () => {
    const stack = nodeCard(nodes['example:api']!, edges, exampleCatalog['example:api'])
    expect(stack.technologies).toEqual(['rust', 'axum', 'sqlx'])
    const frontend = nodeCard(nodes['example:web']!, edges, { ...exampleCatalog['example:web'], technologies: ['react', 'rust', 'redis', 'react', 'angular'] })
    expect(frontend.technologies).toEqual(['react', 'angular', 'vue'])
    expect(frontend.microfrontends.map((microfrontend) => microfrontend.name)).toEqual(['Notes', 'Workspace'])
    expect(frontend.height).toBeGreaterThan(nodeCard(nodes['example:web']!, []).height)
  })

  it('uses SDK metadata from the generated API, keeping declared and observed pages together', () => {
    const frontend = { ...nodes['example:web']!, metadata: { technologies: ['react', 'rust'], pages: ['/declared'],
      microfrontends: [{ name: 'Settings', framework: 'vue', pages: ['/settings'] }] } }
    const card = nodeCard(frontend, edges, { pages: ['/observed'] })
    expect(card.technologies).toEqual(['react', 'vue'])
    expect(card.rows.map((row) => row.label)).toEqual(['/declared', '/observed', '/settings'])
    expect(card.shellPages).toEqual(['/declared', '/observed'])
    const backend = nodeCard({ ...nodes['example:api']!, metadata: { technologies: ['rust', 'tokio', 'custom-library'], pages: [], microfrontends: [] } }, edges)
    expect(backend.technologies).toEqual(['rust', 'tokio', 'custom-library'])
  })

  it('reserves space for every microfrontend page and unassigned shell page', () => {
    const metadata = { microfrontends: [{ name: 'Notes', framework: 'react', pages: ['/one', '/two', '/three'] }] }
    const before = nodeCard(nodes['example:web']!, [], metadata)
    const after = nodeCard(nodes['example:web']!, [], { pages: ['/shell'], microfrontends: [{ ...metadata.microfrontends[0]!, pages: ['/one', '/two', '/three', '/four'] }] })
    expect(after.height - before.height).toBe(24 + 44 + 24)
    expect(after.rows).toHaveLength(5)
  })
})

describe('observed pages', () => {
  it('uses explicit navigation attributes, removes queries and fragments, and deduplicates', () => {
    const catalog = observePage({}, navigation('/notes?token=fake#private'))
    expect(catalog['example:web']?.pages).toEqual(['/notes'])
    expect(observePage(catalog, navigation('/notes'))).toBe(catalog)
    expect(observePage(catalog, { ...navigation('/not-a-page'), kind: 'request' })).toBe(catalog)
    expect(observePage(catalog, { ...navigation('/not-a-page'), layer: 'backend' })).toBe(catalog)
    expect(observePage(catalog, { ...navigation('/not-a-page'), record: null })).toBe(catalog)
    expect(observePage(catalog, navigation('https://other.test/page'))).toBe(catalog)
  })

  it('bounds pages, node count and path length', () => {
    let catalog: NodeCatalog = {}
    for (let i = 0; i < MAX_PAGES + 10; i++) catalog = observePage(catalog, navigation(`/page-${i}`))
    expect(catalog['example:web']?.pages).toHaveLength(MAX_PAGES)
    expect(catalog['example:web']?.pages).not.toContain('/page-0')
    catalog = observePage(catalog, navigation('/' + 'x'.repeat(500)))
    expect(catalog['example:web']?.pages?.at(-1)).toHaveLength(160)
    for (let i = 0; i < MAX_PAGE_NODES + 10; i++) catalog = observePage(catalog, { ...navigation('/'), nodes: [`node-${i}`] })
    expect(Object.keys(catalog)).toHaveLength(MAX_PAGE_NODES)
  })
})
