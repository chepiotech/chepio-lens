// Types
import type { EdgeView } from '../api/generated/EdgeView'
import type { NodeView } from '../api/generated/NodeView'

export type Point = { x: number; y: number }

export const NODE_WIDTH = 176
export const NODE_HEIGHT = 56
const COLUMN_GAP = 160
const ROW_GAP = 40

/**
 * Fixed columns by kind: frontend → services ordered by call depth → databases → external (ADR-0006).
 * Inside a column nodes are sorted by id, so the same graph always gets the same positions and nodes never jump.
 * Positions are node centers in world coordinates; columns are centered on y = 0.
 */
export function layoutGraph(nodes: NodeView[], edges: EdgeView[]): Map<string, Point> {
  const depth = serviceDepths(nodes, edges)
  const serviceColumns = Math.max(0, ...depth.values()) + 1
  const column = (node: NodeView): number => {
    switch (node.kind) {
      case 'frontend':
        return 0
      case 'service':
        return 1 + (depth.get(node.id) ?? 0)
      case 'database':
        return 1 + serviceColumns
      case 'external':
        return 2 + serviceColumns
    }
  }

  const columns = new Map<number, string[]>()
  for (const node of nodes) {
    const ids = columns.get(column(node)) ?? []
    ids.push(node.id)
    columns.set(column(node), ids)
  }

  // Empty columns (no frontend yet, no databases) collapse, so the map stays compact.
  const used = [...columns.keys()].sort((a, b) => a - b)
  const positions = new Map<string, Point>()
  used.forEach((columnIndex, slot) => {
    const ids = (columns.get(columnIndex) ?? []).sort()
    const height = ids.length * NODE_HEIGHT + (ids.length - 1) * ROW_GAP
    ids.forEach((id, row) => {
      positions.set(id, {
        x: slot * (NODE_WIDTH + COLUMN_GAP),
        y: -height / 2 + NODE_HEIGHT / 2 + row * (NODE_HEIGHT + ROW_GAP),
      })
    })
  })
  return positions
}

/** Longest chain of http calls between services leading to each service; services nobody calls get 0. */
function serviceDepths(nodes: NodeView[], edges: EdgeView[]): Map<string, number> {
  const services = new Set(nodes.filter((node) => node.kind === 'service').map((node) => node.id))
  const callers = new Map<string, string[]>()
  for (const edge of edges) {
    if (edge.protocol === 'http' && services.has(edge.from) && services.has(edge.to) && edge.from !== edge.to) {
      callers.set(edge.to, [...(callers.get(edge.to) ?? []), edge.from])
    }
  }
  const depth = new Map<string, number>()
  const visiting = new Set<string>()
  const depthOf = (id: string): number => {
    const known = depth.get(id)
    if (known !== undefined) return known
    // A cycle between services stops here instead of recursing forever.
    if (visiting.has(id)) return 0
    visiting.add(id)
    const value = Math.max(-1, ...(callers.get(id) ?? []).map(depthOf)) + 1
    visiting.delete(id)
    depth.set(id, value)
    return value
  }
  for (const id of [...services].sort()) depthOf(id)
  return depth
}
