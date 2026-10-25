// Types
import type { GraphState } from '../../map/graphState'
import type { Selection } from '../../map/MapRenderer'
// Styles
import './DetailsPanel.css'
// Utils
import { formatMs } from '../../map/formatMs'

type Props = {
  graph: GraphState
  selection: NonNullable<Selection>
  onClose: () => void
  inline?: boolean
}

/** Facts about the selected node or edge, as plain text (I11). */
function DetailsPanel({ graph, selection, onClose, inline = false }: Props) {
  const rows = selection.kind === 'node' ? nodeRows(graph, selection.id) : edgeRows(graph, selection.id)
  if (!rows) return null
  return (
    <aside className={`details-panel${inline ? ' details-panel--inline' : ''}`} aria-label="Selection details">
      <header className="details-panel__header">
        <h2 className="details-panel__title">{rows.title}</h2>
        <button type="button" className="details-panel__close" onClick={onClose} aria-label="Close details">
          ×
        </button>
      </header>
      <dl className="details-panel__list">
        {rows.items.map(([label, value]) => (
          <div key={label} className="details-panel__row">
            <dt>{label}</dt>
            <dd>{value}</dd>
          </div>
        ))}
      </dl>
      {selection.kind === 'edge' && Boolean(graph.edges[selection.id]?.routes.length) && <section aria-label="Calls by route" className="details-panel__routes">
        <h3>Calls by route</h3>
        <ul>{graph.edges[selection.id]!.routes.map((route) => <li key={route.route}>
          <code>{route.route}</code>
          <span>{route.count} calls · {route.errors} errors · mean {formatMs(route.mean_ms)} · max {formatMs(route.max_ms)}</span>
        </li>)}</ul>
      </section>}
    </aside>
  )
}

type Rows = { title: string; items: [string, string][] }

function nodeRows(graph: GraphState, id: string): Rows | null {
  const node = graph.nodes[id]
  if (!node) return null
  const items: [string, string][] = [
    ['Kind', node.kind],
    ['Id', node.id],
  ]
  if (node.db_system) items.push(['Database', node.db_system])
  if (node.address) items.push(['Address', node.port === null ? node.address : `${node.address}:${node.port}`])
  if (node.namespace) items.push(['Name', node.namespace])
  return { title: node.label, items }
}

function edgeRows(graph: GraphState, id: string): Rows | null {
  const edge = graph.edges[id]
  if (!edge) return null
  const label = (nodeId: string) => graph.nodes[nodeId]?.label ?? nodeId
  return {
    title: `${label(edge.from)} → ${label(edge.to)}`,
    items: [
      ['Protocol', edge.protocol],
      ['Last call', edge.last_error ? 'Error' : 'Success'],
      ['Last duration', formatMs(edge.last_duration_ms)],
      ['Calls this session', String(edge.count)],
      ['Errors this session', String(edge.errors)],
      ['Session p50 (approx.)', formatMs(edge.p50_ms)],
      ['Session p95 (approx.)', formatMs(edge.p95_ms)],
      ['Rate', `${edge.rate_per_s.toFixed(2)} /s over 60 s`],
    ],
  }
}

export default DetailsPanel
