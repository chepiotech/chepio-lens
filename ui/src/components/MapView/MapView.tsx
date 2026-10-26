// Core
import { type Ref, useEffect, useImperativeHandle, useRef } from 'react'
// Components
import CanvasIcon from '../CanvasIcon'
// Types
import type { LogEntryView } from '../../api/generated/LogEntryView'
import type { GraphState } from '../../map/graphState'
import type { NodeCatalog } from '../../map/nodeCards/nodeCards'
import type { Pulse } from '../../map/requestPulses'
// Styles
import './MapView.css'
// Utils
import { MapRenderer, type Selection } from '../../map/MapRenderer'

export type MapHandle = { pulse: (pulses: Pulse[]) => void; flash: (entry: LogEntryView) => void; focusNode: (id: string) => void }

type Props = {
  ref?: Ref<MapHandle>
  graph: GraphState
  selection: Selection
  onSelect: (selection: Selection) => void
  catalog?: NodeCatalog
}

function MapView({ ref, graph, selection, onSelect, catalog }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const rendererRef = useRef<MapRenderer | null>(null)
  const onSelectRef = useRef(onSelect)
  onSelectRef.current = onSelect

  useEffect(() => {
    if (!canvasRef.current) return
    const renderer = new MapRenderer(canvasRef.current, (next) => onSelectRef.current(next))
    rendererRef.current = renderer
    return () => {
      renderer.destroy()
      rendererRef.current = null
    }
  }, [])

  useEffect(() => {
    rendererRef.current?.setGraph(Object.values(graph.nodes), Object.values(graph.edges), catalog)
  }, [graph, catalog])

  useEffect(() => {
    rendererRef.current?.setSelection(selection)
  }, [selection])

  useImperativeHandle(ref, () => ({
    pulse: (pulses) => rendererRef.current?.pulse(pulses),
    flash: (entry) => rendererRef.current?.flash(entry),
    focusNode: (id) => id ? rendererRef.current?.focusNode(id) : rendererRef.current?.fit(),
  }), [])

  return (
    <>
    <canvas
      ref={canvasRef}
      className="map-view"
      tabIndex={0}
      onKeyDown={(event) => {
        if (event.key === '+' || event.key === '=') rendererRef.current?.zoom(1.25)
        else if (event.key === '-') rendererRef.current?.zoom(0.8)
        else if (event.key === '0') rendererRef.current?.fit()
        else if (event.key === 'Escape') onSelect(null)
        else if (event.key === 'ArrowRight' || event.key === 'ArrowLeft') {
          const ids = Object.keys(graph.nodes).sort()
          if (!ids.length) return
          const index = selection?.kind === 'node' ? ids.indexOf(selection.id) : -1
          const next = (index + (event.key === 'ArrowRight' ? 1 : -1) + ids.length) % ids.length
          onSelect({ kind: 'node', id: ids[next]! })
        } else return
        event.preventDefault()
      }}
      aria-label="Map of frontends, services, databases, caches and their calls. Drag to pan, scroll to zoom, double-click to fit. Use left and right arrows to inspect nodes, plus and minus to zoom, 0 to fit."
    />
    <div className="map-view__controls" aria-label="Map controls">
      <button type="button" aria-label="Zoom out" title="Zoom out" onClick={() => rendererRef.current?.zoom(0.8)}><CanvasIcon name="minus" /></button>
      <button type="button" aria-label="Zoom in" title="Zoom in" onClick={() => rendererRef.current?.zoom(1.25)}><CanvasIcon name="plus" /></button>
      <button type="button" aria-label="Fit map" title="Fit map" onClick={() => rendererRef.current?.fit()}><CanvasIcon name="fit" /></button>
    </div>
    </>
  )
}

export default MapView
