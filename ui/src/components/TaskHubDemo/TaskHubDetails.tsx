// Components
import CanvasIcon from '../CanvasIcon'
// Types
import type { Selection } from '../../map/MapRenderer'
import type { BoundaryState } from '../../map/mapScene/mapScene'
// Styles
import '../DetailsPanel/DetailsPanel.css'
// Utils
import { taskhubEdges, taskhubNodes, taskhubScene } from '../../taskhub/taskhubTopology'
import { taskhubLogos } from '../../taskhub/taskhubLogos'

type Props = { selection: NonNullable<Selection>; counts: Record<string, number>; onClose: () => void
  onSelect: (selection: Selection) => void; onFocus: (id: string) => void; external: Record<string, BoundaryState> }

function TaskHubDetails({ selection, counts, onClose, onSelect, onFocus, external }: Props) {
  const node = selection.kind === 'node' ? taskhubNodes.find((item) => item.id === selection.id) : undefined
  const edge = selection.kind === 'edge' ? taskhubEdges.find((item) => item.id === selection.id) : undefined
  return <aside className="details-panel taskhub-details" aria-label="Topology details">
    <button type="button" className="taskhub__close" aria-label="Close topology details" onClick={onClose}><CanvasIcon name="close" /></button>
    {node && <>
      <img className="taskhub-details__logo" src={taskhubLogos[node.id]} alt={`${node.label} technology`} width="32" height="32" />
      <h2>{node.label}</h2><p className="taskhub__muted">{node.role} · {taskhubScene.nodes[node.id]!.external ? 'external service' : 'controlled component'}</p>
      {taskhubScene.nodes[node.id]!.external && <section className="taskhub-details__exchange" aria-label="External service exchange">
        <p>Only the caller’s request and response are visible. Internal processing is unknown.</p>
        <p role="status" className={external[node.id]?.status === 'waiting' ? 'taskhub-details__waiting' : ''}>
          {external[node.id]?.status === 'waiting' ? 'Waiting for response…' : external[node.id] ? 'Response received' : 'No request yet. Run a scenario.'}
        </p>
        {external[node.id] && <><h4>Sent request</h4><pre>{external[node.id]!.request}</pre>
          <h4>Received response · simulated</h4><pre>{external[node.id]!.response ?? 'Awaiting response'}</pre></>}
      </section>}
      <p>{node.description}</p>
      <ul>{node.details.map((line) => <li key={line}>{line}</li>)}</ul>
      <button type="button" onClick={() => onFocus(node.id)}>Focus node</button>
      <h3>Connections</h3>
      <div className="taskhub-details__connections">{taskhubEdges.filter((item) => item.from === node.id || item.to === node.id).map((item) =>
        <button type="button" key={item.id} onClick={() => onSelect({ kind: 'edge', id: item.id })}>
          <span>{taskhubNodes.find((target) => target.id === item.from)!.label} → {taskhubNodes.find((target) => target.id === item.to)!.label}</span>
          <small>{item.label}</small>
        </button>)}</div>
    </>}
    {edge && <>
      <h2>{edge.label}</h2><p className="taskhub__muted">{edge.kind.toUpperCase()} · modeled connection</p>
      <p>{taskhubNodes.find((node) => node.id === edge.from)!.label} → {taskhubNodes.find((node) => node.id === edge.to)!.label}</p>
      <p>{counts[edge.id] ?? 0} simulated packets this session.</p>
      <p className="taskhub__muted">Packet counts include requests and responses. No live traffic or measured timing.</p>
      <button type="button" onClick={() => onSelect({ kind: 'node', id: edge.from })}>Inspect source</button>
      <button type="button" onClick={() => onSelect({ kind: 'node', id: edge.to })}>Inspect destination</button>
    </>}
  </aside>
}

export default TaskHubDetails
