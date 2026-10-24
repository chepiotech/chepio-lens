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
