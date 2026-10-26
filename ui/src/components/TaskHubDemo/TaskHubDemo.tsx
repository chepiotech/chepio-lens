// Core
import { useEffect, useRef, useState } from 'react'
// Components
import CanvasIcon from '../CanvasIcon'
import CanvasControls from '../CanvasControls/CanvasControls'
import InvestigationPanel from '../InvestigationPanel/InvestigationPanel'
import ChepioTechFooter from '../ChepioTechFooter/ChepioTechFooter'
import LogsPanel from '../LogsPanel/LogsPanel'
import MapView, { type MapHandle } from '../MapView/MapView'
import RequestInspector, { type RequestSelection } from '../RequestInspector/RequestInspector'
import TaskHubApp from './TaskHubApp'
import TaskHubDetails from './TaskHubDetails'
// Hooks
import { useActivities } from '../../hooks/useActivities'
import { useLogs } from '../../hooks/useLogs'
// Types
import type { LogsView } from '../../activities/activityState'
import type { LogFilters } from '../../logs/logState'
import type { Selection } from '../../map/MapRenderer'
import type { DemoCommand, Scenario } from '../../taskhub/taskhubSimulation'
// Styles
import '../App/App.css'
import './TaskHubDemo.css'
import '../MapSummary/MapSummary.css'
// Utils
import TaskHubConsoleSource from '../../taskhub/TaskHubConsoleSource/TaskHubConsoleSource'
import { readLogsView, saveLogsView } from '../../activities/activityState'
import { DEFAULT_FILTERS } from '../../logs/logState'
import { advanceSimulation, initialDemoState, isRunning, SCENARIOS, startSimulation } from '../../taskhub/taskhubSimulation'
import { readPanelPreferences, savePanelPreferences } from '../InvestigationPanel/panelPreferences'
import { taskhubEdges, taskhubGraph, taskhubNodes, taskhubScene } from '../../taskhub/taskhubTopology'

function TaskHubDemo() {
  const map = useRef<MapHandle>(null)
  const appButton = useRef<HTMLButtonElement>(null)
  const surface = useRef<HTMLDivElement>(null)
  const source = useRef<TaskHubConsoleSource | null>(null)
  source.current ??= new TaskHubConsoleSource()
  const consoleSource = source.current
  const [preferences, setPreferences] = useState(readPanelPreferences)
  const [state, setState] = useState(initialDemoState)
  const [scenario, setScenario] = useState<Scenario>('task')
  const [panel, setPanel] = useState<'app' | 'console' | null>(null)
  const [selection, setSelection] = useState<Selection>(null)
  const [error, setError] = useState('')
  const [resetVersion, setResetVersion] = useState(0)
  const [filters, setFilters] = useState<LogFilters>(DEFAULT_FILTERS)
  const [logsView, setLogsView] = useState<LogsView>(readLogsView)
  const [requestSelection, setRequestSelection] = useState<RequestSelection | null>(null)
  const [requestRevision, setRequestRevision] = useState(0)
  // The same console as the live map, fed by the simulation instead of the collector.
  const logs = useLogs(filters, panel === 'console' && logsView === 'lines', resetVersion, consoleSource.fetchLogs)
  const activities = useActivities(filters, panel === 'console' && logsView === 'actions', resetVersion, consoleSource.fetchActivities)
  const running = isRunning(state)
  const activeStep = running ? state.flow?.steps[state.stepIndex] : undefined

  useEffect(() => {
    if (!state.flow || state.stepIndex >= state.flow.steps.length) return
    const flowId = state.flow.id
    const index = state.stepIndex
    map.current?.playScenePacket(state.flow.steps[index]!)
    const timer = window.setTimeout(() => setState((current) =>
      current.flow?.id === flowId && current.stepIndex === index ? advanceSimulation(current) : current), state.flow.steps[index]!.durationMs)
    return () => window.clearTimeout(timer)
  }, [state.flow, state.stepIndex])

  // Every completed step is logged, also while the console is closed; an open console refreshes like on SSE events.
  const selectedTrace = requestSelection?.traceId
  useEffect(() => {
    const activity = consoleSource.sync(state)
    if (!activity) return
    logs.invalidate()
    activities.onEvent({ activity, replaces: [] })
    if (selectedTrace && activity.traces.includes(selectedTrace)) setRequestRevision((value) => value + 1)
  }, [state, consoleSource, logs.invalidate, activities.onEvent, selectedTrace])

  useEffect(() => savePanelPreferences(preferences), [preferences])
  useEffect(() => saveLogsView(logsView), [logsView])
  useEffect(() => {
    if (panel) surface.current?.querySelector<HTMLButtonElement>('.investigation-panel__header button')?.focus()
  }, [panel])

  const run = (command: DemoCommand) => {
    try {
      setState(startSimulation(state, command))
      setScenario(command.type)
      setError('')
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Could not start the scenario. Reset the demo and try again.'
      consoleSource.recordAction(SCENARIOS.find((item) => item.id === command.type)!.label, { error: message })
      logs.invalidate()
      activities.resync()
      setError(message)
    }
  }
  const closePanel = () => {
    setPanel(null)
    if (panel === 'app') appButton.current?.focus()
    else surface.current?.querySelector<HTMLButtonElement>('[aria-label="Console"]')?.focus()
  }
  const select = (next: Selection) => { setSelection(next); if (next) setPanel(null) }
  const reset = () => {
    consoleSource.clear()
    setState(initialDemoState())
    setResetVersion((version) => version + 1)
    setSelection(null)
    setRequestSelection(null)
    setError('')
    map.current?.clearScenePackets()
  }

  return <div ref={surface} className="app taskhub" onKeyDown={(event) => {
    if (event.key === 'Escape' && panel) { closePanel(); event.stopPropagation() }
    else if (event.key === 'Escape' && selection) setSelection(null)
  }}>
    <main className="app__main">
      <div className="app__map">
        <MapView ref={map} graph={taskhubGraph} scene={taskhubScene} boundaryStates={state.external} selection={selection} onSelect={select} />
        <CanvasControls graph={taskhubGraph} example consoleOpen={panel === 'console'}
          onToggleConsole={() => {
            if (panel !== 'console') setRequestSelection(null)
            setPanel(panel === 'console' ? null : 'console')
            setSelection(null)
          }}
          preferences={preferences} onPreferences={setPreferences}
          onFocusNode={(id) => { select(id ? { kind: 'node', id } : null); map.current?.focusNode(id) }} />
        <div className="taskhub__controls" role="group" aria-label="Simulation controls">
          <a className="canvas-controls__button" href="?" aria-label="Back to live map" title="Back to live map"><CanvasIcon name="map" /></a>
          <button ref={appButton} type="button" className="canvas-controls__button" aria-label="Open demo app" title="Open demo app"
            aria-expanded={panel === 'app'} aria-controls="request-console"
            onClick={() => { setPanel(panel === 'app' ? null : 'app'); setSelection(null) }}><CanvasIcon name="app" /></button>
          <label className="taskhub__scenario-picker"><span className="map-summary">Scenario</span>
            <select value={scenario} disabled={running} onChange={(event) => setScenario(event.target.value as Scenario)}>
              {SCENARIOS.map((item) => <option key={item.id} value={item.id}>{item.label}</option>)}
            </select>
          </label>
          <button type="button" className="canvas-controls__button" aria-label="Run scenario" title={running ? 'Running…' : 'Run scenario'}
            disabled={running} onClick={() => run({ type: scenario })}><CanvasIcon name="play" /></button>
          <button type="button" className="canvas-controls__button" aria-label="Reset demo" title="Reset demo" onClick={reset}><CanvasIcon name="reset" /></button>
        </div>
        {(state.flow || error) && <div className="taskhub__status">
          <div role="status" aria-live="polite">{error || (running ? `${state.stepIndex + 1}/${state.flow!.steps.length} · ${activeStep!.detail}`
            : state.flow ? `${state.flow.title} complete.` : '')}</div>
          {state.flow && <progress aria-label="Scenario progress" value={state.stepIndex} max={state.flow.steps.length} />}
        </div>}
        <section className="map-summary" aria-label="TaskHub topology as text">
          <h2>Modeled groups</h2><ul>{taskhubScene.groups.map((group) => <li key={group.label}>{group.label}</li>)}</ul>
          <h2>Modeled nodes</h2><ul>{taskhubNodes.map((node) => <li key={node.id}>{node.label}: {node.role}. {node.description}
            {taskhubScene.nodes[node.id]!.external && ` External service. ${state.external[node.id]?.status === 'waiting' ? 'Waiting for response.' : state.external[node.id] ? 'Response received.' : 'No request yet.'}`}
          </li>)}</ul>
          <h2>Modeled connections</h2><ul>{taskhubEdges.map((edge) => <li key={edge.id}>
            {taskhubGraph.nodes[edge.from]!.label} → {taskhubGraph.nodes[edge.to]!.label}: {edge.kind}, {edge.label}
          </li>)}</ul>
        </section>
        {selection && <TaskHubDetails selection={selection} counts={state.counts} external={state.external} onSelect={select}
          onClose={() => setSelection(null)} onFocus={(id) => { map.current?.focusNode(id); setSelection(null) }} />}
      </div>
      {panel === 'app' && <InvestigationPanel preferences={preferences} onPreferences={setPreferences} onClose={closePanel}
        title="TaskHub app" label="TaskHub demo app" closeLabel="Close demo panel">
        <div className="taskhub__panel-content"><TaskHubApp key={resetVersion} state={state} onRun={run} /></div>
      </InvestigationPanel>}
      {panel === 'console' && <InvestigationPanel preferences={preferences} onPreferences={setPreferences} onClose={closePanel}>
        <LogsPanel graph={taskhubGraph} filters={filters} onFilters={setFilters} logs={logs} activities={activities}
          view={logsView} onView={setLogsView} visible={!requestSelection} loadActivity={consoleSource.fetchActivity}
          onInspectStep={(step) => { activities.pause(); setRequestSelection({ traceId: step.trace_id, spanId: step.span_id }) }}
          onInspect={(entry) => { logs.pause(); setRequestSelection({ traceId: entry.trace_id, spanId: entry.span_id, log: entry.record ? entry : undefined }) }} />
        {requestSelection && <RequestInspector selection={requestSelection} revision={requestRevision}
          loadRequest={consoleSource.fetchRequest} onBack={() => setRequestSelection(null)} />}
      </InvestigationPanel>}
    </main>
    <ChepioTechFooter />
  </div>
}

export default TaskHubDemo
