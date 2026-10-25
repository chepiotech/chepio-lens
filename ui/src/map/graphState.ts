// Types
import type { EdgeView } from '../api/generated/EdgeView'
import type { GraphView } from '../api/generated/GraphView'
import type { NodeView } from '../api/generated/NodeView'

export type GraphState = {
  nodes: Record<string, NodeView>
  edges: Record<string, EdgeView>
}

export type GraphAction =
  | { type: 'snapshot'; graph: GraphView }
  | { type: 'node'; node: NodeView }
  | { type: 'edge'; edge: EdgeView }
  | { type: 'clear' }

export const emptyGraph: GraphState = { nodes: {}, edges: {} }

/** Merge only events received while this snapshot was loading, never state from an earlier connection/reset. */
export function mergeGraphSnapshot(snapshot: GraphView, updates: GraphState): GraphView {
  const nodes = new Map(snapshot.nodes.map((node) => [node.id, node]))
  const edges = new Map(snapshot.edges.map((edge) => [edge.id, edge]))
  for (const node of Object.values(updates.nodes)) {
    const existing = nodes.get(node.id)
    if (!existing || BigInt(node.last_seen) >= BigInt(existing.last_seen)) nodes.set(node.id, node)
  }
  for (const edge of Object.values(updates.edges)) {
    const existing = edges.get(edge.id)
    // A snapshot may already include some buffered events; cumulative counts identify the newer view.
    if (!existing || edge.count > existing.count) edges.set(edge.id, edge)
  }
  return { ...snapshot, nodes: [...nodes.values()], edges: [...edges.values()] }
}

/** A snapshot replaces everything; SSE events upsert one node or edge. */
export function graphReducer(state: GraphState, action: GraphAction): GraphState {
  switch (action.type) {
    case 'snapshot':
      return {
        nodes: Object.fromEntries(action.graph.nodes.map((node) => [node.id, node])),
        edges: Object.fromEntries(action.graph.edges.map((edge) => [edge.id, edge])),
      }
    case 'node':
      return { ...state, nodes: { ...state.nodes, [action.node.id]: action.node } }
    case 'edge':
      return { ...state, edges: { ...state.edges, [action.edge.id]: action.edge } }
    case 'clear':
      return emptyGraph
  }
}
