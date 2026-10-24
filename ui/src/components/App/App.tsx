// Core
import { useCallback, useRef, useState } from 'react'
// Components
import ChepioTechFooter from '../ChepioTechFooter/ChepioTechFooter'
import DetailsPanel from '../DetailsPanel/DetailsPanel'
import MapView, { type MapHandle } from '../MapView/MapView'
// Hooks
import { useLensFeed } from '../../hooks/useLensFeed'
// Types
import type { RequestView } from '../../api/generated/RequestView'
import type { Selection } from '../../map/MapRenderer'
// Styles
import './App.css'

const STATUS_TEXT = { connecting: 'Connecting…', live: 'Live', offline: 'Collector offline' } as const

function App() {
  const mapRef = useRef<MapHandle>(null)
  const [selection, setSelection] = useState<Selection>(null)
  const onRequest = useCallback((request: RequestView) => mapRef.current?.pulse(request.edges), [])
  const { graph, status, reset } = useLensFeed(onRequest)
  const nodeCount = Object.keys(graph.nodes).length
  const edgeCount = Object.keys(graph.edges).length

  return (
    <div className="app">
      <header className="app__header">
        <h1 className="app__title">chepio-lens</h1>
        <span className={`app__status app__status--${status}`} role="status">
          {STATUS_TEXT[status]}
        </span>
        <span className="app__counts">
          {nodeCount} nodes · {edgeCount} edges
        </span>
        <button
          type="button"
          className="app__reset"
          onClick={() => {
            setSelection(null)
            void reset()
          }}
        >
          Reset
        </button>
      </header>
      <main className="app__main">
        <MapView ref={mapRef} graph={graph} selection={selection} onSelect={setSelection} />
        {selection && <DetailsPanel graph={graph} selection={selection} onClose={() => setSelection(null)} />}
      </main>
      <ChepioTechFooter />
    </div>
  )
}

export default App
