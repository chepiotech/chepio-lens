// Core
import { type Ref, useEffect, useImperativeHandle, useRef } from 'react'
// Types
import type { GraphState } from '../../map/graphState'
// Utils
import { MapRenderer, type Selection } from '../../map/MapRenderer'
import type { Pulse } from '../../map/requestPulses'
// Styles
import './MapView.css'

export type MapHandle = { pulse: (pulses: Pulse[]) => void }

type Props = {
  ref?: Ref<MapHandle>
  graph: GraphState
  selection: Selection
  onSelect: (selection: Selection) => void
}

function MapView({ ref, graph, selection, onSelect }: Props) {
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
    rendererRef.current?.setGraph(Object.values(graph.nodes), Object.values(graph.edges))
  }, [graph])

  useEffect(() => {
    rendererRef.current?.setSelection(selection)
  }, [selection])

  useImperativeHandle(ref, () => ({ pulse: (pulses) => rendererRef.current?.pulse(pulses) }), [])

  return (
    <canvas
      ref={canvasRef}
      className="map-view"
      aria-label="Live map of services, databases and the calls between them. Drag to pan, scroll to zoom, double-click to fit."
    />
  )
}

export default MapView
