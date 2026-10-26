// Types
import type { EdgeView } from '../../api/generated/EdgeView'
import type { LogEntryView } from '../../api/generated/LogEntryView'
import type { NodeView } from '../../api/generated/NodeView'

export type Technology = string
export type FrontendFramework = string
export type Microfrontend = { name: string; framework: FrontendFramework; pages: string[] }
export type NodeMetadata = { technologies?: Technology[]; pages?: string[]; microfrontends?: Microfrontend[]; description?: string }
export type NodeCatalog = Record<string, NodeMetadata>
export type CardRow = { tag: string; label: string; count?: number }
export type NodeCard = {
  kind: 'frontend' | 'service' | 'database' | 'cache' | 'external'
  role: string
  technologies: Technology[]
  microfrontends: Microfrontend[]
  shellPages: string[]
  height: number
  subtitle: string
  section: string
  rows: CardRow[]
  empty: string
  footer: string
}

export const CARD_ROWS = 8
export const MAX_PAGES = 32
export const MAX_PAGE_NODES = 200
const TECHNOLOGY_LABELS: Record<string, string> = { react: 'React', vue: 'Vue', angular: 'Angular', rust: 'Rust', axum: 'axum', sqlx: 'SQLx', postgresql: 'PostgreSQL', redis: 'Redis', svelte: 'Svelte', nextjs: 'Next.js', nuxt: 'Nuxt', solid: 'Solid', preact: 'Preact', qwik: 'Qwik', tokio: 'Tokio' }
export const technologyLabel = (technology: string): string => Object.hasOwn(TECHNOLOGY_LABELS, technology) ? TECHNOLOGY_LABELS[technology]! : technology
const FRONTEND_FRAMEWORKS = new Set(['react', 'vue', 'angular', 'svelte', 'solid', 'preact', 'nextjs', 'nuxt', 'qwik'])
export const microfrontendHeight = (microfrontend: { pages: string[] }) => 44 + microfrontend.pages.length * 24

/** Cache is a presentation of the existing database node contract, never a guessed service name. */
export function nodeKind(node: NodeView): NodeCard['kind'] {
  return node.kind === 'database' && node.db_system?.toLowerCase() === 'redis' ? 'cache' : node.kind
}

/** Aggregate the callee's routes across callers. Outgoing URLs are not frontend pages or service endpoints. */
export function nodeCard(node: NodeView, edges: EdgeView[], metadata: NodeMetadata = {}): NodeCard {
  metadata = { ...node.metadata, ...metadata, pages: [...(node.metadata?.pages ?? []), ...(metadata.pages ?? [])] }
  const kind = nodeKind(node)
  const incoming = edges.filter((edge) => edge.to === node.id)
  const routes = new Map<string, number>()
  for (const edge of incoming) {
    for (const route of edge.routes) routes.set(route.route, (routes.get(route.route) ?? 0) + route.count)
  }
  const observed = [...routes].sort(([a, ac], [b, bc]) => bc - ac || a.localeCompare(b))
  const system = node.db_system?.toLowerCase()
  const microfrontends = kind === 'frontend' ? (metadata.microfrontends ?? []).slice(0, 8) : []
  const technologies: Technology[] = system === 'redis' ? ['redis'] : system === 'postgresql' || system === 'postgres' ? ['postgresql']
    : [...new Set([...(metadata.technologies ?? []), ...microfrontends.map((microfrontend) => microfrontend.framework)])]
      .filter((technology) => kind !== 'frontend' || FRONTEND_FRAMEWORKS.has(technology))
  const role = { frontend: 'Frontend', service: 'Backend', database: 'Database', cache: 'Cache', external: 'External' }[kind]
  const techLabel = technologies.map(technologyLabel).join(' · ') || node.db_system
  const address = node.address ? `${node.address}${node.port === null ? '' : `:${node.port}`}` : null
  const pages = [...new Set([...(metadata.pages ?? []), ...microfrontends.flatMap((microfrontend) => microfrontend.pages)])].sort()
  const ownedPages = new Set(microfrontends.flatMap((microfrontend) => microfrontend.pages))
  const shellPages = microfrontends.length ? pages.filter((page) => !ownedPages.has(page)) : []
  const connections = edges.filter((edge) => edge.from === node.id).length
  const rows = kind === 'frontend'
    ? pages.map((page) => ({ tag: 'PAGE', label: page }))
    : observed.map(([route, count]) => {
      const match = /^(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS|SELECT|INSERT|UPDATE|SET|GETDEL|DEL|HGET|HSET|EXPIRE|INCR)\s+(.+)$/.exec(route)
      return { tag: match?.[1] ?? (kind === 'cache' ? 'CMD' : kind === 'database' ? 'SQL' : 'RPC'), label: match?.[2] ?? route, count }
    })
  return {
    kind, role, technologies, microfrontends, shellPages,
    height: Math.max(320, 242 + (microfrontends.length ? microfrontends.reduce((sum, microfrontend) => sum + microfrontendHeight(microfrontend), shellPages.length ? microfrontendHeight({ pages: shellPages }) : 0) : Math.min(rows.length, CARD_ROWS) * 28))
      + Math.max(0, Math.ceil(technologies.length / 3) - 1) * 30,
    subtitle: metadata.description ?? [techLabel, address ?? (kind === 'frontend' ? 'Browser application' : kind === 'service' ? 'Application service' : node.namespace)].filter(Boolean).join(' · '),
    section: kind === 'frontend' ? 'Pages' : kind === 'service' || kind === 'external' ? 'Observed endpoints' : 'Observed operations',
    rows,
    empty: kind === 'frontend' ? 'No navigation observed yet' : 'No operations observed yet',
    footer: kind === 'frontend'
      ? `${pages.length} ${pages.length === 1 ? 'page' : 'pages'} · ${connections} ${connections === 1 ? 'connection' : 'connections'}`
      : `${incoming.reduce((sum, edge) => sum + edge.count, 0).toLocaleString('en-US')} calls · ${node.namespace ?? role.toLowerCase()}`,
  }
}

/** Navigation has an explicit path attribute. Never use free-text logs, request URLs, query strings or hashes. */
export function observePage(catalog: NodeCatalog, entry: LogEntryView): NodeCatalog {
  if (entry.layer !== 'frontend' || entry.kind !== 'action') return catalog
  const path = entry.record?.attributes.find((attribute) => attribute.key === 'url.path')?.values[0]?.split(/[?#]/, 1)[0]
  if (!path?.startsWith('/') || path.startsWith('//')) return catalog
  const safePath = path.slice(0, 160)
  let next = catalog
  for (const id of entry.nodes.slice(0, MAX_PAGE_NODES)) {
    const previous = next[id]
    if (previous?.pages?.includes(safePath)) continue
    if (!previous && Object.keys(next).length >= MAX_PAGE_NODES) continue
    if (next === catalog) next = { ...catalog }
    next[id] = { ...previous, pages: [...(previous?.pages ?? []).slice(-(MAX_PAGES - 1)), safePath] }
  }
  return next
}
