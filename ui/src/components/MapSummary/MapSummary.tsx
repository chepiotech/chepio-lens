// Types
import type { GraphState } from '../../map/graphState'
// Styles
import './MapSummary.css'
// Utils
import { formatMs } from '../../map/formatMs'

type Props = { graph: GraphState }

/** Text alternative for the canvas (WCAG 1.1.1): every node and every edge with its numbers. Visually hidden. */
function MapSummary({ graph }: Props) {
  const label = (id: string) => graph.nodes[id]?.label ?? id
  const nodes = Object.values(graph.nodes).sort((a, b) => a.label.localeCompare(b.label))
  const edges = Object.values(graph.edges)
    .map((edge) => ({ edge, text: `${label(edge.from)} → ${label(edge.to)}` }))
    .sort((a, b) => a.text.localeCompare(b.text))

  return (
    <section className="map-summary" aria-label="Map as text">
      <h2>Nodes</h2>
      <ul>
        {nodes.map((node) => (
          <li key={node.id}>{`${node.label} (${node.kind})`}</li>
        ))}
      </ul>
      <h2>Calls</h2>
      <ul>
        {edges.map(({ edge, text }) => (
          <li key={edge.id}>
            {`${text}: ${edge.count} ${edge.count === 1 ? 'call' : 'calls'}, ${edge.errors} errors, p95 ${formatMs(edge.p95_ms)}`}
          </li>
        ))}
      </ul>
    </section>
  )
}

export default MapSummary
