// Core
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
// Components
import ActivityList from '../ActivityList/ActivityList'
// Hooks
import type { useActivities } from '../../hooks/useActivities'
import type { useLogs } from '../../hooks/useLogs'
// Types
import type { LogEntryView } from '../../api/generated/LogEntryView'
import type { StepView } from '../../api/generated/StepView'
import type { LogsView } from '../../activities/activityState'
import type { GraphState } from '../../map/graphState'
import type { LogFilters } from '../../logs/logState'
// Styles
import './LogsPanel.css'
// Utils
import { DEFAULT_FILTERS, LAYERS, LOG_VIEW_LIMIT, logTime } from '../../logs/logState'
import { formatMs } from '../../map/formatMs'

type Props = {
  graph: GraphState
  filters: LogFilters
  onFilters: (filters: LogFilters) => void
  logs: ReturnType<typeof useLogs>
  activities: ReturnType<typeof useActivities>
  view: LogsView
  onView: (view: LogsView) => void
  onInspect: (entry: LogEntryView) => void
  onInspectStep: (step: StepView) => void
  visible: boolean
}

/** Actions (ADR-0016): one row per user action or request, expanding into its chain. Lines: one row per span or log. */
function LogsPanel({ graph, filters, onFilters, logs, activities, view, onView, onInspect, onInspectStep, visible }: Props) {
  const list = useRef<HTMLDivElement>(null)
  const anchor = useRef<{ id: string; offset: number } | null>(null)
  const [showFilters, setShowFilters] = useState(false)
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set())
  const actions = view === 'actions'
  const live = actions ? activities : logs
  const rows = actions ? activities.activities : logs.entries
  const rowId = (element: HTMLElement) => (actions ? element.dataset.activityId : element.dataset.logId)
  const rowSelector = actions ? '[data-activity-id]' : '[data-log-id]'
  const toggle = (id: string) => {
    setExpanded((current) => {
      const next = new Set(current)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
    activities.pause()
  }
  useEffect(() => {
    const media = window.matchMedia('(min-width: 761px)')
    const update = () => setShowFilters(media.matches)
    update()
    media.addEventListener('change', update)
    return () => media.removeEventListener('change', update)
  }, [])
  const patch = (value: Partial<LogFilters>) => onFilters({ ...filters, ...value })
  const loadOlder = () => {
    if (list.current) {
      const top = list.current.getBoundingClientRect().top
      const row = [...list.current.querySelectorAll<HTMLElement>(rowSelector)].find((item) => item.getBoundingClientRect().bottom >= top)
      const id = row && rowId(row)
      if (row && id) anchor.current = { id, offset: row.getBoundingClientRect().top - top }
    }
    live.loadOlder()
  }
  useLayoutEffect(() => {
    const element = list.current
    if (!element || !visible) return
    if (live.following) element.scrollTop = element.scrollHeight
    else if (anchor.current && !live.loading) {
      const row = [...element.querySelectorAll<HTMLElement>(rowSelector)].find((item) => rowId(item) === anchor.current?.id)
      if (row) element.scrollTop += row.getBoundingClientRect().top - element.getBoundingClientRect().top - anchor.current.offset
      anchor.current = null
    }
  }, [rows, live.following, live.loading, visible])
  const nodeLabel = (id: string) => graph.nodes[id]?.label ?? id
  return (
    <section className="logs-panel" aria-label="Request logs" hidden={!visible}>
      <div className="logs-panel__filters">
        <fieldset className="logs-panel__layers">
          <legend>Layers</legend>
          {LAYERS.map((layer) => <button type="button" key={layer} className={`logs-panel__layer logs-panel__layer--${layer}`}
            aria-pressed={filters.layers.includes(layer)} disabled={filters.layers.length === 1 && filters.layers.includes(layer)}
            onClick={() => patch({ layers: filters.layers.includes(layer) ? filters.layers.filter((item) => item !== layer) : [...filters.layers, layer] })}>
            {layer}
          </button>)}
        </fieldset>
        <label className="logs-panel__search">Search logs
          <input type="search" value={filters.text} placeholder="Message, request, SQL or trace ID" onChange={(event) => patch({ text: event.target.value })} />
        </label>
        <details className="logs-panel__advanced" open={showFilters} onToggle={(event) => setShowFilters(event.currentTarget.open)}>
          <summary>More filters{[filters.node, filters.edge, filters.status, ...(actions ? [filters.origin] : [filters.level, filters.kind])].filter(Boolean).length > 0 ? ' · active' : ''}</summary>
          <div className="logs-panel__filter-grid">
          <label>Node<select value={filters.node} onChange={(event) => patch({ node: event.target.value })}>
            <option value="">All nodes</option>
            {Object.values(graph.nodes).map((node) => <option key={node.id} value={node.id}>{node.label}</option>)}
          </select></label>
          <label>Edge<select value={filters.edge} onChange={(event) => patch({ edge: event.target.value })}>
            <option value="">All edges</option>
            {Object.values(graph.edges).map((edge) => <option key={edge.id} value={edge.id}>{nodeLabel(edge.from)} → {nodeLabel(edge.to)}</option>)}
          </select></label>
          <label>Status<select value={filters.status} onChange={(event) => patch({ status: event.target.value as LogFilters['status'] })}>
            <option value="">Any status</option><option value="ok">Success</option><option value="error">Error</option>
          </select></label>
          {actions ? <label>Origin<select value={filters.origin} onChange={(event) => patch({ origin: event.target.value as LogFilters['origin'] })}>
            <option value="">Actions and requests</option><option value="action">User actions</option><option value="request">Requests without an action</option>
          </select></label> : <>
          <label>Level<select value={filters.level} onChange={(event) => patch({ level: event.target.value as LogFilters['level'] })}>
            <option value="">All levels</option>{['trace', 'debug', 'info', 'warn', 'error', 'fatal'].map((level) => <option value={level} key={level}>{level}</option>)}
          </select></label>
          <label>Kind<select value={filters.kind} onChange={(event) => patch({ kind: event.target.value as LogFilters['kind'] })}>
            <option value="">All activity</option>{['log', 'action', 'request', 'query', 'call', 'span'].map((kind) => <option value={kind} key={kind}>{kind}</option>)}
          </select></label></>}
          <button type="button" className="logs-panel__clear" onClick={() => onFilters(DEFAULT_FILTERS)}>Clear filters</button>
          </div>
        </details>
      </div>
      <div className="logs-panel__toolbar">
        <div className="logs-panel__views" role="group" aria-label="View">
          <button type="button" aria-pressed={actions} onClick={() => onView('actions')}>Actions</button>
          <button type="button" aria-pressed={!actions} onClick={() => onView('lines')}>Lines</button>
        </div>
        <span>{actions
          ? `${activities.activities.length.toLocaleString()} ${activities.activities.length === 1 ? 'action' : 'actions'}`
          : `${logs.entries.length.toLocaleString()} lines${logs.entries.length === LOG_VIEW_LIMIT ? ' · view limit' : ''}`}</span>
        <button type="button" aria-pressed={live.following} onClick={live.following ? live.pause : live.resume}>
          {live.following ? 'Pause live' : live.hasNew ? 'Resume live · new activity' : 'Resume live'}
        </button>
      </div>
      {live.error && <div className="logs-panel__error" role="alert">{live.error} <button type="button" onClick={live.reload}>{actions ? 'Retry actions' : 'Retry logs'}</button></div>}
      <div className="logs-panel__list" ref={list} tabIndex={0} aria-label={actions ? 'Action list' : 'Log lines'} aria-busy={live.loading}
        onScroll={(event) => {
          const element = event.currentTarget
          if (live.following && element.scrollHeight - element.scrollTop - element.clientHeight > 32) live.pause()
          if (!live.following && element.scrollTop < 12 && live.before && !live.loading && element.scrollHeight > element.clientHeight) loadOlder()
        }}>
        {live.before && <button className="logs-panel__older" type="button" disabled={live.loading} onClick={loadOlder}>
          {live.loading ? 'Loading…' : actions ? 'Load earlier actions' : 'Load earlier lines'}
        </button>}
        {!rows.length && <p className="logs-panel__empty">{live.loading ? (actions ? 'Loading actions…' : 'Loading logs…')
          : filters.text || filters.node || filters.edge || filters.status || (actions ? filters.origin : filters.level || filters.kind) || filters.layers.length < 3
            ? (actions ? 'No actions match these filters.' : 'No lines match these filters.') : 'No activity yet. Send a request from your app.'}</p>}
        {actions && <ActivityList activities={activities.activities} revisions={activities.revisions} expanded={expanded}
          onToggle={toggle} onInspect={onInspectStep} />}
        {!actions && <ol className="logs-panel__entries" aria-label="Log entries">
          {logs.entries.map((entry) => <li key={entry.id} data-log-id={entry.id}>
            <button type="button" className={`logs-panel__entry${entry.error ? ' logs-panel__entry--error' : ''}`} onClick={() => onInspect(entry)}>
              <span className="logs-panel__entry-meta"><time>{logTime(entry.time)}</time>
                <span className={`logs-panel__tag logs-panel__tag--${entry.layer}`}>{entry.layer}</span>
                <span className="logs-panel__service">{entry.service}</span>
                <span className="logs-panel__status">{entry.status_code ?? entry.level ?? (entry.error ? 'error' : entry.kind)}</span>
                <span>{entry.duration_ms === null ? entry.kind : formatMs(entry.duration_ms)}</span>
              </span>
              <span className="logs-panel__text">{entry.text}</span>
            </button>
          </li>)}
        </ol>}
      </div>
    </section>
  )
}

export default LogsPanel
