// Types
import type { LucideIcon } from '../icons/lucideIcons'
import type { NodeSize, Point } from '../layoutGraph'
import type { NodeCard } from '../nodeCards/nodeCards'

/** Presentation for explicitly declared, illustrative topology. Never inferred from live telemetry. */
export type SceneNode = NodeSize & {
  position: Point
  role: string
  caption: string
  color: string
  icon: LucideIcon
  logo?: string
  external?: boolean
  card: NodeCard
}
export type ConnectionKind = 'http' | 'sql' | 'event' | 'pubsub' | 'websocket' | 'storage' | 'auth'
export type SceneEdge = { points: Point[]; kind: ConnectionKind; label: string }
export type SceneGroup = { label: string; note: string; x: number; y: number; width: number; height: number; logo?: string }
export type MapScene = { nodes: Record<string, SceneNode>; edges: Record<string, SceneEdge>; groups: SceneGroup[] }
export type ScenePacket = { edgeId: string; reverse?: boolean; label: string; durationMs: number }
export type BoundaryState = { status: 'waiting' | 'success'; request: string; response: string | null; label: string }

export const CONNECTION_COLORS: Record<ConnectionKind, string> = {
  http: '#98aecb', sql: '#88b6dd', event: '#e5bb73', pubsub: '#d69fbc',
  websocket: '#86c7ba', storage: '#b7a4d8', auth: '#c7b788',
}

/** Constant distance, including across elbows; a packet must not jump over a short segment. */
export function pointOnRoute(points: Point[], progress: number): Point {
  const lengths = points.slice(1).map((point, index) => Math.hypot(point.x - points[index]!.x, point.y - points[index]!.y))
  let remaining = lengths.reduce((sum, length) => sum + length, 0) * Math.max(0, Math.min(1, progress))
  for (let index = 0; index < lengths.length; index++) {
    const length = lengths[index]!
    if (length > 0 && remaining <= length) {
      const from = points[index]!
      const to = points[index + 1]!
      return { x: from.x + (to.x - from.x) * remaining / length, y: from.y + (to.y - from.y) * remaining / length }
    }
    remaining -= length
  }
  return points.at(-1) ?? { x: 0, y: 0 }
}

export function distanceToRoute(points: Point[], point: Point): number {
  return Math.min(...points.slice(1).map((to, index) => {
    const from = points[index]!
    const dx = to.x - from.x
    const dy = to.y - from.y
    const lengthSquared = dx * dx + dy * dy
    const t = lengthSquared ? Math.max(0, Math.min(1, ((point.x - from.x) * dx + (point.y - from.y) * dy) / lengthSquared)) : 0
    return Math.hypot(point.x - from.x - t * dx, point.y - from.y - t * dy)
  }))
}
