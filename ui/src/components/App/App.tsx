// Core
import { useCallback, useEffect, useRef, useState } from 'react'
// Components
import CanvasControls from '../CanvasControls/CanvasControls'
import ChepioTechFooter from '../ChepioTechFooter/ChepioTechFooter'
import DetailsPanel from '../DetailsPanel/DetailsPanel'
import InvestigationPanel from '../InvestigationPanel/InvestigationPanel'
import LogsPanel from '../LogsPanel/LogsPanel'
import MapSummary from '../MapSummary/MapSummary'
import MapView, { type MapHandle } from '../MapView/MapView'
import RequestInspector, { type RequestSelection } from '../RequestInspector/RequestInspector'
// Hooks
import { useActivities } from '../../hooks/useActivities'
import { useLensFeed } from '../../hooks/useLensFeed'
import { useLogs } from '../../hooks/useLogs'
// Types
import type { LogEntryView } from '../../api/generated/LogEntryView'
import type { StepView } from '../../api/generated/StepView'
import type { LogsView } from '../../activities/activityState'
import type { RequestView } from '../../api/generated/RequestView'
import type { Selection } from '../../map/MapRenderer'
import type { LogFilters } from '../../logs/logState'
// Styles
import './App.css'
// Utils
import { RequestSettler } from '../../map/RequestSettler'
import { pulsesFor } from '../../map/requestPulses'
import { DEFAULT_FILTERS } from '../../logs/logState'
import { readLogsView, saveLogsView } from '../../activities/activityState'
import { readPanelPreferences, savePanelPreferences } from '../InvestigationPanel/panelPreferences'
import { observePage, type NodeCatalog } from '../../map/nodeCards/nodeCards'

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
  const [catalog, setCatalog] = useState<NodeCatalog>({})
  const [logsView, setLogsView] = useState<LogsView>(readLogsView)
  // Only the shown view loads; both follow the same filters.
  const logs = useLogs(filters, panelOpen && logsView === 'lines', session)
  const activities = useActivities(filters, panelOpen && logsView === 'actions', session)
  useEffect(() => savePanelPreferences(preferences), [preferences])
  useEffect(() => saveLogsView(logsView), [logsView])
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
    setCatalog((previous) => observePage(previous, entry))
    logs.invalidate()
    mapRef.current?.flash(entry)
  }, [logs.invalidate])
  const onResync = useCallback(() => { logs.resync(); activities.resync() }, [logs.resync, activities.resync])
  const { graph, status, reset } = useLensFeed(onRequest, onLog, onResync, activities.onEvent)
  const inspectStep = (step: StepView) => {
    activities.pause()
    setRequestSelection({ traceId: step.trace_id, spanId: step.span_id })
  }
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
      setCatalog({})
      setRequestSelection(null)
      setFilters(DEFAULT_FILTERS)
      setSession((value) => value + 1)
      settlerRef.current?.clear()
    } catch { setResetError(true) }
    finally { setResetting(false) }
  }

  return (
    <div className="app">
      <main className="app__main">
        <div className="app__map">
          <MapView ref={mapRef} graph={graph} catalog={catalog} selection={selection} onSelect={select} />
          <MapSummary graph={graph} catalog={catalog} />
          <CanvasControls graph={graph} status={status} consoleOpen={panelOpen} onToggleConsole={() => {
            if (!panelOpen) setRequestSelection(null)
            setPanelOpen((value) => !value)
          }}
            preferences={preferences} onPreferences={setPreferences} resetting={resetting} resetError={resetError}
            onReset={() => { void resetAll() }} onFocusNode={(id) => { setSelection(null); mapRef.current?.focusNode(id) }} />
          {selection?.kind === 'node' && <DetailsPanel graph={graph} catalog={catalog} selection={selection} onClose={() => setSelection(null)} />}
        </div>
        {panelOpen && <InvestigationPanel preferences={preferences} onPreferences={setPreferences} onClose={() => setPanelOpen(false)}>
          {!requestSelection && selection?.kind === 'edge' && filters.edge === selection.id && <details className="app__edge-details">
            <summary>Edge statistics and routes</summary>
            <DetailsPanel graph={graph} selection={selection} inline onClose={() => setSelection(null)} />
          </details>}
          <LogsPanel graph={graph} filters={filters} onFilters={setFilters} logs={logs} activities={activities}
            view={logsView} onView={setLogsView} onInspectStep={inspectStep} visible={!requestSelection}
            onInspect={(entry) => { logs.pause(); setRequestSelection({ traceId: entry.trace_id, spanId: entry.span_id, log: entry.record ? entry : undefined }) }} />
          {requestSelection && <RequestInspector selection={requestSelection} revision={requestRevision} onBack={() => setRequestSelection(null)} />}
        </InvestigationPanel>}
      </main>
      <ChepioTechFooter />
    </div>
  )
}

export default App
