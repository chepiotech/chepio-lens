// Core
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
// Hooks
import type { useLogs } from '../../hooks/useLogs'
// Types
import type { LogEntryView } from '../../api/generated/LogEntryView'
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
  onInspect: (entry: LogEntryView) => void
  visible: boolean
}

function LogsPanel({ graph, filters, onFilters, logs, onInspect, visible }: Props) {
  const list = useRef<HTMLDivElement>(null)
  const anchor = useRef<{ id: string; offset: number } | null>(null)
  const [showFilters, setShowFilters] = useState(false)
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
      const row = [...list.current.querySelectorAll<HTMLElement>('[data-log-id]')].find((item) => item.getBoundingClientRect().bottom >= top)
      if (row?.dataset.logId) anchor.current = { id: row.dataset.logId, offset: row.getBoundingClientRect().top - top }
    }
    logs.loadOlder()
  }
  useLayoutEffect(() => {
    const element = list.current
    if (!element || !visible) return
    if (logs.following) element.scrollTop = element.scrollHeight
    else if (anchor.current && !logs.loading) {
      const row = [...element.querySelectorAll<HTMLElement>('[data-log-id]')].find((item) => item.dataset.logId === anchor.current?.id)
      if (row) element.scrollTop += row.getBoundingClientRect().top - element.getBoundingClientRect().top - anchor.current.offset
      anchor.current = null
    }
  }, [logs.entries, logs.following, logs.loading, visible])
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
          <summary>More filters{[filters.node, filters.edge, filters.status, filters.level, filters.kind].filter(Boolean).length > 0 ? ' · active' : ''}</summary>
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
          <label>Level<select value={filters.level} onChange={(event) => patch({ level: event.target.value as LogFilters['level'] })}>
            <option value="">All levels</option>{['trace', 'debug', 'info', 'warn', 'error', 'fatal'].map((level) => <option value={level} key={level}>{level}</option>)}
          </select></label>
          <label>Kind<select value={filters.kind} onChange={(event) => patch({ kind: event.target.value as LogFilters['kind'] })}>
            <option value="">All activity</option>{['log', 'action', 'request', 'query', 'call', 'span'].map((kind) => <option value={kind} key={kind}>{kind}</option>)}
          </select></label>
          <button type="button" className="logs-panel__clear" onClick={() => onFilters(DEFAULT_FILTERS)}>Clear filters</button>
          </div>
        </details>
      </div>
      <div className="logs-panel__toolbar">
        <span>{logs.entries.length.toLocaleString()} lines{logs.entries.length === LOG_VIEW_LIMIT ? ' · view limit' : ''}</span>
        <button type="button" aria-pressed={logs.following} onClick={logs.following ? logs.pause : logs.resume}>
          {logs.following ? 'Pause live' : logs.hasNew ? 'Resume live · new activity' : 'Resume live'}
        </button>
      </div>
      {logs.error && <div className="logs-panel__error" role="alert">{logs.error} <button type="button" onClick={logs.reload}>Retry logs</button></div>}
      <div className="logs-panel__list" ref={list} tabIndex={0} aria-label="Log lines" aria-busy={logs.loading}
        onScroll={(event) => {
          const element = event.currentTarget
          if (logs.following && element.scrollHeight - element.scrollTop - element.clientHeight > 32) logs.pause()
          if (!logs.following && element.scrollTop < 12 && logs.before && !logs.loading && element.scrollHeight > element.clientHeight) loadOlder()
        }}>
        {logs.before && <button className="logs-panel__older" type="button" disabled={logs.loading} onClick={loadOlder}>
          {logs.loading ? 'Loading…' : 'Load earlier lines'}
        </button>}
        {!logs.entries.length && <p className="logs-panel__empty">{logs.loading ? 'Loading logs…' : filters.text || filters.node || filters.edge || filters.status || filters.level || filters.kind || filters.layers.length < 3
          ? 'No lines match these filters.' : 'No activity yet. Send a request from your app.'}</p>}
        <ol className="logs-panel__entries" aria-label="Log entries">
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
        </ol>
      </div>
    </section>
  )
}

export default LogsPanel
