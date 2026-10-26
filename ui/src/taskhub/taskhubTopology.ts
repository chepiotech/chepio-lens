// Types
import type { GraphState } from '../map/graphState'
import type { LucideIcon } from '../map/icons/lucideIcons'
import type { ConnectionKind, MapScene, SceneNode } from '../map/mapScene/mapScene'
import type { NodeCard } from '../map/nodeCards/nodeCards'
// Utils
import { NODE_WIDTH } from '../map/layoutGraph'
import { kubernetesLogo, taskhubLogos } from './taskhubLogos'

type NodeSpec = {
  id: string; label: string; role: string; caption: string; description: string; x: number; y: number
  icon: LucideIcon; color: string; group: 'client' | 'edge' | 'apps' | 'platform'; details: string[]
}

export const taskhubNodes: NodeSpec[] = [
  { id: 'browser', label: 'Browser / Client', role: 'Client', caption: 'User actions · HTTP + WebSocket', x: 0, y: 0,
    icon: 'navigation', color: '#a4b8e8', group: 'client', description: 'Starts requests and receives realtime updates.',
    details: ['Pages: /login, /projects, /projects/:id/board, /tasks/:id', 'Uploads sample objects directly to storage after authorization.'] },
  { id: 'dns', label: 'DNS / CDN / WAF', role: 'Edge network', caption: 'Name resolution · delivery · filtering', x: 280, y: 0,
    icon: 'lock', color: '#a4b8e8', group: 'client', description: 'Models the external access boundary as one logical node.',
    details: ['DNS resolution is not an HTTP proxy hop.', 'This visual access path does not run DNS, a CDN or a WAF.'] },
  { id: 'load-balancer', label: 'Cloud Load Balancer', role: 'Load balancer', caption: 'Public entry → cluster gateway', x: 560, y: 0,
    icon: 'rows-3', color: '#a4b8e8', group: 'client', description: 'Routes incoming traffic to the edge gateway.',
    details: ['A logical cloud boundary; no cloud resources are provisioned.'] },
  { id: 'envoy', label: 'Envoy Gateway', role: 'Gateway', caption: '/ · /api · /ws · /auth', x: 560, y: 170,
    icon: 'rows-3', color: '#b4c797', group: 'edge', description: 'Routes web, API, realtime and identity traffic.',
    details: ['/ → Next.js Web', '/api → API BFF', '/ws → Realtime Gateway', '/auth → Keycloak'] },
  { id: 'web', label: 'Next.js Web', role: 'Web application', caption: 'Next.js · 3 modeled replicas', x: 560, y: 330,
    icon: 'file-braces', color: '#a4b8e8', group: 'apps', description: 'Serves the TaskHub interface and calls the BFF for server rendering.',
    details: ['Target stack: Next.js / TypeScript', 'The simulator itself uses the existing React UI; no Next.js server runs.'] },
  { id: 'bff', label: 'NestJS API BFF', role: 'Backend for frontend', caption: 'NestJS · 3 modeled replicas', x: 840, y: 330,
    icon: 'file-braces', color: '#b4c797', group: 'apps', description: 'Coordinates public API calls, sessions and domain services.',
    details: ['/api/v1/projects', '/api/v1/projects/:id/tasks', '/api/v1/tasks/:id/comments', '/api/v1/search', 'Sessions → Redis; identity → Keycloak.'] },
  { id: 'projects', label: 'Projects Service', role: 'Domain service', caption: 'NestJS · projects_db', x: 560, y: 505,
    icon: 'file-braces', color: '#b4c797', group: 'apps', description: 'Owns projects, membership and project authorization.',
    details: ['2 modeled replicas', 'Other services consult its API, never its tables.'] },
  { id: 'tasks', label: 'Tasks Service', role: 'Domain service', caption: 'FastAPI · tasks_db + outbox', x: 840, y: 505,
    icon: 'file-braces', color: '#b4c797', group: 'apps', description: 'Saves tasks and their outbox events together.',
    details: ['3 modeled replicas', 'HTTP 201 precedes asynchronous search and notification updates.', 'Publishes task.created through the outbox.'] },
  { id: 'comments', label: 'Comments Service', role: 'Domain service', caption: 'Go · comments_db + outbox', x: 280, y: 505,
    icon: 'file-braces', color: '#b4c797', group: 'apps', description: 'Stores comments and publishes comment.created.',
    details: ['2 modeled replicas', 'Comments belong to a task, without a cross-database foreign key.'] },
  { id: 'files', label: 'Files Service', role: 'Domain service', caption: 'NestJS · files_db', x: 0, y: 505,
    icon: 'file', color: '#b4c797', group: 'apps', description: 'Authorizes uploads and confirms attachment metadata.',
    details: ['2 modeled replicas', 'Presign → direct client upload → verify → ready.', 'The demo attaches a synthetic file; it never reads or uploads local files.'] },
  { id: 'search', label: 'Search Service', role: 'Search projection', caption: 'FastAPI · event consumer', x: 1120, y: 505,
    icon: 'file-text', color: '#b4c797', group: 'apps', description: 'Updates OpenSearch from task events and queries the index.',
    details: ['2 modeled replicas', 'The index is eventually consistent, not the source of truth.'] },
  { id: 'notifications', label: 'Notification Worker', role: 'Background worker', caption: 'Python · notifications_db', x: 0, y: 330,
    icon: 'send', color: '#e5bb73', group: 'apps', description: 'Consumes task and comment events and persists notifications.',
    details: ['2 modeled replicas', 'RabbitMQ consumer → PostgreSQL → Redis Pub/Sub.'] },
  { id: 'realtime', label: 'Realtime Gateway', role: 'Realtime service', caption: 'Node.js · WebSocket', x: 280, y: 330,
    icon: 'send', color: '#86c7ba', group: 'apps', description: 'Relays Redis Pub/Sub messages to connected browsers.',
    details: ['2 modeled replicas', 'Push is transient; notification history belongs to the worker database.'] },
  { id: 'redis', label: 'Redis', role: 'Cache / Pub/Sub', caption: 'Sessions · realtime backplane', x: -60, y: 740,
    icon: 'rows-3', color: '#d69fbc', group: 'platform', description: 'Models session storage and transient realtime signals.',
    details: ['No durable notification data is owned by Redis.'] },
  { id: 'storage', label: 'MinIO / S3', role: 'Object storage', caption: 'Private objects · signed URLs', x: 190, y: 740,
    icon: 'file', color: '#b7a4d8', group: 'platform', description: 'Stores uploaded objects independently of the BFF.',
    details: ['A modeled S3-compatible boundary, not an installed MinIO dependency.'] },
  { id: 'postgres', label: 'PostgreSQL', role: 'Isolated databases', caption: '5 service-owned databases', x: 440, y: 740,
    icon: 'database', color: '#88b6dd', group: 'platform', description: 'One visual cluster with separate logical databases.',
    details: ['projects_db', 'tasks_db', 'comments_db', 'files_db', 'notifications_db', 'Services never read another service’s tables.'] },
  { id: 'rabbitmq', label: 'RabbitMQ', role: 'Message broker', caption: 'taskhub.events · topic exchange', x: 690, y: 740,
    icon: 'rows-3', color: '#e5bb73', group: 'platform', description: 'Fans events out to independent consumer queues.',
    details: ['notifications.q: task.created, comment.created', 'search-index.q: task.*', 'Delivery is modeled; no real broker or durability guarantee.'] },
  { id: 'opensearch', label: 'OpenSearch', role: 'Search index', caption: 'Task documents · read model', x: 940, y: 740,
    icon: 'file-text', color: '#88b6dd', group: 'platform', description: 'Contains the asynchronously indexed task projection.',
    details: ['A task appears in search only after its indexing step.'] },
  { id: 'keycloak', label: 'Keycloak', role: 'Identity provider', caption: 'OIDC · authorization code + PKCE', x: 1190, y: 740,
    icon: 'lock', color: '#c7b788', group: 'platform', description: 'Models a sign-in flow and identity verification.',
    details: ['Demo identity only. No credentials, tokens or real authentication.'] },
]

type Port = 'top' | 'bottom' | 'left' | 'right'
type EdgeSpec = { id: string; from: string; to: string; kind: ConnectionKind; label: string; fromPort: Port; toPort: Port; via: [number, number][] }
function link(from: string, to: string, kind: ConnectionKind, label: string, fromPort: Port, toPort: Port, via: [number, number][] = []): EdgeSpec {
  return { id: `${from}:${to}`, from, to, kind, label, fromPort, toPort, via }
}

export const taskhubEdges: EdgeSpec[] = [
  link('browser', 'dns', 'http', 'HTTPS / access', 'right', 'left'),
  link('dns', 'load-balancer', 'http', 'HTTPS', 'right', 'left'),
  link('load-balancer', 'envoy', 'http', 'HTTPS', 'bottom', 'top'),
  link('envoy', 'web', 'http', '/', 'bottom', 'top'),
  link('envoy', 'bff', 'http', '/api', 'right', 'top', [[840, 170]]),
  link('envoy', 'realtime', 'websocket', '/ws', 'left', 'top', [[280, 170]]),
  link('envoy', 'keycloak', 'auth', '/auth', 'right', 'right', [[1320, 170], [1320, 740]]),
  link('web', 'bff', 'http', 'SSR / HTTP', 'right', 'left'),
  ...['files', 'comments', 'projects', 'tasks', 'search'].map((id) => {
    const target = taskhubNodes.find((node) => node.id === id)!
    return link('bff', id, 'http', `/api/v1/${id}`, 'bottom', 'top', [[840, 414], [target.x, 414]])
  }),
  link('bff', 'redis', 'auth', 'Session', 'right', 'top', [[1260, 330], [1260, 640], [-60, 640]]),
  link('bff', 'keycloak', 'auth', 'OIDC identity', 'right', 'top', [[1285, 330], [1285, 660], [1190, 660]]),
  link('tasks', 'projects', 'http', 'Check membership', 'left', 'right'),
  link('projects', 'postgres', 'sql', 'projects_db', 'bottom', 'top', [[560, 620], [440, 620]]),
  link('tasks', 'postgres', 'sql', 'tasks_db + outbox', 'bottom', 'top', [[840, 600], [440, 600]]),
  link('comments', 'postgres', 'sql', 'comments_db + outbox', 'bottom', 'top', [[280, 600], [440, 600]]),
  link('files', 'postgres', 'sql', 'files_db', 'bottom', 'top', [[0, 620], [440, 620]]),
  link('notifications', 'postgres', 'sql', 'notifications_db', 'left', 'top', [[-175, 330], [-175, 600], [440, 600]]),
  link('files', 'storage', 'storage', 'Presign / verify', 'bottom', 'top', [[0, 665], [190, 665]]),
  link('browser', 'storage', 'storage', 'Direct upload', 'top', 'bottom', [[0, -75], [1370, -75], [1370, 875], [190, 875]]),
  link('tasks', 'rabbitmq', 'event', 'task.created', 'bottom', 'top', [[840, 580], [690, 580]]),
  link('comments', 'rabbitmq', 'event', 'comment.created', 'bottom', 'top', [[280, 580], [690, 580]]),
  link('rabbitmq', 'notifications', 'event', 'notifications.q', 'bottom', 'left', [[690, 850], [-240, 850], [-240, 330]]),
  link('rabbitmq', 'search', 'event', 'search-index.q', 'right', 'bottom', [[815, 740], [815, 620], [1120, 620]]),
  link('search', 'opensearch', 'http', 'Index / query', 'bottom', 'top', [[1120, 660], [940, 660]]),
  link('notifications', 'redis', 'pubsub', 'Publish notification', 'left', 'left', [[-195, 330], [-195, 740]]),
  link('redis', 'realtime', 'pubsub', 'Subscribe', 'left', 'top', [[-265, 740], [-265, 235], [280, 235]]),
  link('realtime', 'browser', 'websocket', 'Push update', 'left', 'left', [[-290, 330], [-290, 0]]),
]

const technologies: Record<string, string> = {
  browser: 'Chrome', dns: 'Network', 'load-balancer': 'Load balancer', envoy: 'Envoy', web: 'Next.js',
  bff: 'NestJS', projects: 'NestJS', tasks: 'FastAPI', comments: 'Go', files: 'NestJS', search: 'FastAPI',
  notifications: 'Python', realtime: 'Node.js', redis: 'Redis', storage: 'S3', postgres: 'PostgreSQL',
  rabbitmq: 'RabbitMQ', opensearch: 'OpenSearch', keycloak: 'Keycloak',
}
// Keep the declared topology, with room for the same detailed cards used on the live map.
const SCALE_X = 2
const SCALE_Y = 2.8
const nodes: MapScene['nodes'] = Object.fromEntries(taskhubNodes.map((node) => {
  const external = node.group === 'platform' || node.id === 'dns' || node.id === 'load-balancer'
  const kind: NodeCard['kind'] = node.id === 'browser' ? 'frontend' : node.id === 'redis' ? 'cache'
    : node.id === 'postgres' ? 'database' : external ? 'external' : 'service'
  const rows = external ? [] : node.id === 'browser'
    ? ['/login', '/projects', '/projects/:id/board', '/tasks/:id'].map((label) => ({ tag: 'PAGE', label }))
    : taskhubEdges.filter((edge) => edge.to === node.id).map((edge) => ({ tag: edge.kind.toUpperCase(), label: edge.label }))
  const card: NodeCard = {
    kind, role: external ? 'External service' : node.role, technologies: [technologies[node.id]!],
    microfrontends: [], shellPages: [], height: Math.max(320, 242 + Math.min(rows.length, 8) * 28),
    subtitle: node.caption, section: external ? 'Caller-visible exchange' : node.id === 'browser' ? 'Pages' : 'Declared connections',
    rows, empty: 'No request yet', footer: external ? 'Request / response · internal processing unknown'
      : `${taskhubEdges.filter((edge) => edge.from === node.id || edge.to === node.id).length} connections`,
  }
  return [node.id, { width: NODE_WIDTH, height: card.height, position: { x: node.x * SCALE_X, y: node.y * SCALE_Y }, role: node.role,
    caption: node.caption, color: node.color, icon: node.icon, logo: taskhubLogos[node.id], external, card }]
}))
function port(node: SceneNode, side: Port) {
  return { x: node.position.x + (side === 'left' ? -node.width / 2 : side === 'right' ? node.width / 2 : 0),
    y: node.position.y + (side === 'top' ? -node.height / 2 : side === 'bottom' ? node.height / 2 : 0) }
}

export const taskhubScene: MapScene = {
  nodes,
  edges: Object.fromEntries(taskhubEdges.map((edge) => [edge.id, { kind: edge.kind, label: edge.label,
    points: [port(nodes[edge.from]!, edge.fromPort), ...edge.via.map(([x, y]) => ({ x: x * SCALE_X, y: y * SCALE_Y })), port(nodes[edge.to]!, edge.toPort)],
  }])),
  groups: [
    { label: 'Kubernetes Cluster', note: '', x: -210, y: 70, width: 1550, height: 760, logo: kubernetesLogo },
    { label: 'Namespace: edge', note: '', x: 410, y: 100, width: 300, height: 145 },
    { label: 'Namespace: apps', note: '9 components · 21 modeled replicas', x: -150, y: 260, width: 1430, height: 310 },
    { label: 'Platform & Data', note: '', x: -190, y: 655, width: 1520, height: 155 },
  ].map((group) => ({ ...group, x: group.x * SCALE_X, y: group.y * SCALE_Y, width: group.width * SCALE_X, height: group.height * SCALE_Y })),
}

/** Adapter for shared map selection and camera controls. Protocol labels come exclusively from the scene. */
export const taskhubGraph: GraphState = {
  nodes: Object.fromEntries(taskhubNodes.map((node) => [node.id, { id: node.id, label: node.label,
    kind: node.group === 'client' ? 'external' : node.group === 'apps' || node.group === 'edge' ? 'service' : 'external',
    db_system: null, namespace: null, address: null, port: null, first_seen: '0', last_seen: '0',
  }])),
  edges: Object.fromEntries(taskhubEdges.map((edge) => [edge.id, { id: edge.id, from: edge.from, to: edge.to,
    protocol: edge.kind === 'sql' ? 'db' : 'http', count: 0, errors: 0, last_error: false, last_duration_ms: 0,
    p50_ms: 0, p95_ms: 0, rate_per_s: 0, routes: [], last_seen: '0',
  }])),
}
