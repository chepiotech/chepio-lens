// Core
import { useCallback, useEffect, useRef, useState } from 'react'
// Components
import ChepioTechFooter from '../ChepioTechFooter/ChepioTechFooter'
import DetailsPanel from '../DetailsPanel/DetailsPanel'
import InvestigationPanel from '../InvestigationPanel/InvestigationPanel'
import LogsPanel from '../LogsPanel/LogsPanel'
import MapLegend from '../MapLegend/MapLegend'
import MapSummary from '../MapSummary/MapSummary'
import MapView, { type MapHandle } from '../MapView/MapView'
import RequestInspector, { type RequestSelection } from '../RequestInspector/RequestInspector'
// Hooks
import { useLensFeed } from '../../hooks/useLensFeed'
import { useLogs } from '../../hooks/useLogs'
// Types
import type { LogEntryView } from '../../api/generated/LogEntryView'
import type { RequestView } from '../../api/generated/RequestView'
import type { Selection } from '../../map/MapRenderer'
import type { LogFilters } from '../../logs/logState'
// Styles
import './App.css'
// Utils
import { RequestSettler } from '../../map/RequestSettler'
import { pulsesFor } from '../../map/requestPulses'
import { DEFAULT_FILTERS } from '../../logs/logState'
import { readPanelPreferences, savePanelPreferences } from '../InvestigationPanel/panelPreferences'

const STATUS_TEXT = { connecting: 'Connecting…', live: 'Live', offline: 'Collector offline' } as const

function App() {
  const mapRef = useRef<MapHandle>(null)
  const [selection, setSelection] = useState<Selection>(null)
  const [panelOpen, setPanelOpen] = useState(false)
  const [preferences, setPreferences] = useState(readPanelPreferences)
  const [filters, setFilters] = useState<LogFilters>(DEFAULT_FILTERS)
  const [requestSelection, setRequestSelection] = useState<RequestSelection | null>(null)
  const [requestRevision, setRequestRevision] = useState(0)
  const [session, setSession] = useState(0)
  const [resetting, setResetting] = useState(false)
  const [resetError, setResetError] = useState(false)
  const logs = useLogs(filters, panelOpen, session)
  useEffect(() => savePanelPreferences(preferences), [preferences])
  // Each request is animated once, when all its batches have arrived (RequestSettler).
  const settlerRef = useRef<RequestSettler | null>(null)
  settlerRef.current ??= new RequestSettler((request) => mapRef.current?.pulse(pulsesFor(request.hops)))
  useEffect(() => () => settlerRef.current?.clear(), [])
  const onRequest = useCallback((request: RequestView) => {
    settlerRef.current?.push(request)
    logs.invalidate()
    if (request.trace_id === requestSelection?.traceId) setRequestRevision((value) => value + 1)
  }, [logs.invalidate, requestSelection?.traceId])
  // Each log line refreshes the panel; log records and user actions also flash at their nodes on the map.
  const onLog = useCallback((entry: LogEntryView) => {
    logs.invalidate()
    mapRef.current?.flash(entry)
  }, [logs.invalidate])
  const { graph, status, reset } = useLensFeed(onRequest, onLog, logs.resync)
  const nodeCount = Object.keys(graph.nodes).length
  const edgeCount = Object.keys(graph.edges).length
  const select = (next: Selection) => {
    setSelection(next)
    if (next?.kind === 'edge') {
      setFilters({ ...DEFAULT_FILTERS, edge: next.id })
      setRequestSelection(null)
      setPanelOpen(true)
    }
  }
  const resetAll = async () => {
    setResetting(true)
    setResetError(false)
    try {
      await reset()
      setSelection(null)
      setRequestSelection(null)
      setFilters(DEFAULT_FILTERS)
      setSession((value) => value + 1)
      settlerRef.current?.clear()
    } catch { setResetError(true) }
    finally { setResetting(false) }
  }

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
          aria-expanded={panelOpen}
          onClick={() => setPanelOpen((value) => !value)}
        >
          Logs
        </button>
        <button type="button" className="app__reset" disabled={resetting} onClick={() => { void resetAll() }}
        >
          {resetting ? 'Resetting…' : 'Reset'}
        </button>
      </header>
      {resetError && <p className="app__error" role="alert">Reset failed. Check the collector connection and try again.</p>}
      <main className={`app__main${panelOpen ? ` app__main--${preferences.dock}` : ''}`}>
        <div className="app__map">
          <MapView ref={mapRef} graph={graph} selection={selection} onSelect={select} />
          <MapSummary graph={graph} />
          <MapLegend />
          {selection?.kind === 'node' && <DetailsPanel graph={graph} selection={selection} onClose={() => setSelection(null)} />}
        </div>
        {panelOpen && <InvestigationPanel preferences={preferences} onPreferences={setPreferences} onClose={() => setPanelOpen(false)}>
          {!requestSelection && selection?.kind === 'edge' && filters.edge === selection.id && <details className="app__edge-details">
            <summary>Edge statistics and routes</summary>
            <DetailsPanel graph={graph} selection={selection} inline onClose={() => setSelection(null)} />
          </details>}
          <LogsPanel graph={graph} filters={filters} onFilters={setFilters} logs={logs} visible={!requestSelection}
            onInspect={(entry) => { logs.pause(); setRequestSelection({ traceId: entry.trace_id, spanId: entry.span_id, log: entry.record ? entry : undefined }) }} />
          {requestSelection && <RequestInspector selection={requestSelection} revision={requestRevision} onBack={() => setRequestSelection(null)} />}
        </InvestigationPanel>}
      </main>
      <ChepioTechFooter />
    </div>
  )
}

export default App
