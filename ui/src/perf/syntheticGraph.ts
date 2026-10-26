// Types
import type { EdgeView } from '../api/generated/EdgeView'
import type { NodeKindView } from '../api/generated/NodeKindView'
import type { NodeView } from '../api/generated/NodeView'

/** Node mix of the target graph size in docs/architecture/quality-attributes.md (50 nodes). */
const MIX: [NodeKindView, number][] = [
  ['frontend', 5],
  ['service', 30],
  ['database', 10],
  ['external', 5],
]

/** Deterministic pseudo-random numbers (mulberry32), so every run draws the same map. */
function random(seed: number): () => number {
  let state = seed
  return () => {
    state = (state + 0x6d2b79f5) | 0
    let t = Math.imul(state ^ (state >>> 15), 1 | state)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296
  }
}

/** A graph of 50 nodes and `edgeCount` distinct edges that call "rightwards": frontends → services → stores. */
export function syntheticGraph(edgeCount = 100, seed = 42): { nodes: NodeView[]; edges: EdgeView[] } {
  const next = random(seed)
  const nodes: NodeView[] = MIX.flatMap(([kind, count]) =>
    Array.from({ length: count }, (_, i) => ({
      id: `${kind}:${String(i).padStart(2, '0')}`,
      kind,
      label: `${kind}-${i}`,
      db_system: kind === 'database' ? (i % 3 === 0 ? 'redis' : 'postgresql') : null,
      metadata: kind === 'frontend' ? {
        technologies: ['react', 'vue'], pages: ['/'], microfrontends: [
          { name: 'Notes', framework: 'react', pages: ['/notes', '/notes/:id'] },
          { name: 'Workspace', framework: 'vue', pages: ['/settings'] },
        ],
      } : kind === 'service' ? { technologies: ['rust', 'axum', 'sqlx', 'tokio'], pages: [], microfrontends: [] } : undefined,
      address: null,
      port: null,
      namespace: null,
      first_seen: '0',
      last_seen: '0',
    })),
  )
  const ofKind = (kind: NodeKindView) => nodes.filter((node) => node.kind === kind)
  const callers = [...ofKind('frontend'), ...ofKind('service')]
  const pick = <T>(items: T[]): T => items[Math.floor(next() * items.length)] as T
  const edges = new Map<string, EdgeView>()
  while (edges.size < edgeCount) {
    const from = pick(callers)
    const to = from.kind === 'frontend' ? pick(ofKind('service')) : pick(nodes.filter((node) => node.kind !== 'frontend'))
    if (from.id === to.id) continue
    const id = `${from.id}->${to.id}`
    edges.set(id, {
      id,
      from: from.id,
      to: to.id,
      protocol: to.kind === 'database' ? 'db' : 'http',
      count: 1 + Math.floor(next() * 5_000),
      errors: Math.floor(next() * 20),
      last_error: false,
      last_duration_ms: 0.06,
      p50_ms: 1 + next() * 50,
      p95_ms: 5 + next() * 400,
      rate_per_s: next() * 50,
      routes: (to.kind === 'database' ? to.db_system === 'redis' ? ['GET notes', 'SET notes'] : ['SELECT notes', 'INSERT notes']
        : ['GET /api/notes', 'POST /api/notes', 'DELETE /api/notes/:id']).map((route) => ({ route, count: 1, errors: 0, mean_ms: 1, max_ms: 1 })),
      last_seen: '0',
    })
  }
  return { nodes, edges: [...edges.values()] }
}
