// Types
import type { EdgeView } from '../api/generated/EdgeView'
import type { NodeView } from '../api/generated/NodeView'
import type { GraphState } from './graphState'
import type { NodeCatalog } from './nodeCards/nodeCards'

const node = (id: string, kind: NodeView['kind'], label: string, db_system: string | null = null, port: number | null = null): NodeView => ({
  id, kind, label, db_system, port, address: port ? 'localhost' : null,
  namespace: db_system === 'redis' ? 'cache' : db_system ? 'notes' : null, first_seen: '0', last_seen: '0',
})
const edge = (from: string, to: string, protocol: EdgeView['protocol'], duration: number, routes: [string, number][]): EdgeView => ({
  id: `${from}->${to}`, from, to, protocol, count: routes.reduce((sum, [, count]) => sum + count, 0),
  errors: 0, last_error: false, last_duration_ms: duration, p50_ms: duration, p95_ms: duration * 1.4, rate_per_s: 2.4,
  routes: routes.map(([route, count]) => ({ route, count, errors: 0, mean_ms: duration, max_ms: duration * 2 })), last_seen: '0',
})
const nodes = [
  node('example:web', 'frontend', 'Notes web'),
  node('example:api', 'service', 'Notes API'),
  node('example:cache', 'database', 'Redis', 'redis', 6379),
  node('example:postgres', 'database', 'PostgreSQL', 'postgresql', 5432),
]
const edges = [
  edge('example:web', 'example:api', 'http', 24.6, [['GET /api/notes', 128], ['POST /api/notes', 24], ['DELETE /api/notes/:id', 8], ['POST /api/login', 12], ['GET /healthz', 4]]),
  edge('example:api', 'example:cache', 'db', 0.8, [['GET notes:list', 110], ['SET notes:list', 18], ['DEL notes:list', 24]]),
  edge('example:api', 'example:postgres', 'db', 4.2, [['SELECT notes', 18], ['INSERT notes', 24], ['DELETE notes', 8]]),
]

/** Illustrative data lives only in the explicitly selected example; it is never sent to the collector. */
export const exampleGraph: GraphState = {
  nodes: Object.fromEntries(nodes.map((value) => [value.id, value])),
  edges: Object.fromEntries(edges.map((value) => [value.id, value])),
}
export const exampleCatalog: NodeCatalog = {
  'example:web': { technologies: ['react', 'vue'], description: 'Browser application · 2 microfrontends', microfrontends: [
    { name: 'Notes', framework: 'react', pages: ['/notes', '/notes/:id'] },
    { name: 'Workspace', framework: 'vue', pages: ['/', '/settings'] },
  ] },
  'example:api': { technologies: ['rust', 'axum', 'sqlx'], description: 'HTTP API · notes & authentication' },
}
