// Core
import { useEffect, useMemo, useState } from 'react'
// Components
import SpanContent from './SpanContent'
import LogContent from './LogContent'
// Services
import { fetchRequest } from '../../api/lensApi'
// Types
import type { RequestDetailView } from '../../api/generated/RequestDetailView'
import type { LogEntryView } from '../../api/generated/LogEntryView'
// Styles
import './RequestInspector.css'
// Utils
import { clockSkew, spanDepth, spanError } from './requestDetails'
import { formatMs } from '../../map/formatMs'

export type RequestSelection = { traceId: string | null; spanId: string | null; log?: LogEntryView }
type Props = { selection: RequestSelection; revision: number; onBack: () => void }

function RequestInspector({ selection, revision, onBack }: Props) {
  const [detail, setDetail] = useState<RequestDetailView | null>(null)
  const [selectedSpan, setSelectedSpan] = useState(selection.spanId)
  const [error, setError] = useState<string | null>(null)
  const [attempt, setAttempt] = useState(0)
  const [loading, setLoading] = useState(true)
  useEffect(() => { setSelectedSpan(selection.spanId) }, [selection.traceId, selection.spanId])
  useEffect(() => {
    const traceId = selection.traceId
    if (!traceId) { setDetail(null); setError(null); setLoading(false); return }
    const controller = new AbortController()
    setLoading(true)
    setError(null)
    const timer = setTimeout(() => {
      void fetchRequest(traceId, controller.signal).then((value) => {
        if (!controller.signal.aborted) { setDetail(value); setLoading(false) }
      }, (reason: unknown) => {
        if (!controller.signal.aborted) {
          setError(reason instanceof Error ? reason.message : 'Could not load this request.')
          setLoading(false)
        }
      })
    }, 100)
    return () => { clearTimeout(timer); controller.abort() }
  }, [selection.traceId, revision, attempt])
  const current = detail?.request.trace_id === selection.traceId ? detail : null
  const spansById = useMemo(() => new Map(current?.spans.map((item) => [item.span_id, item]) ?? []), [current])
  const span = current?.spans.find((item) => item.span_id === selectedSpan) ?? current?.spans[0]
  const duration = Math.max(0.001, ...current?.spans.map((item) => item.start_offset_ms + item.duration_ms) ?? [])
  return <section className="request-inspector" aria-label="Request inspector" aria-busy={loading}>
    <div className="request-inspector__toolbar"><button type="button" onClick={onBack}>← Back to logs</button>
      <button type="button" onClick={() => setAttempt((value) => value + 1)} disabled={loading || !selection.traceId}>Refresh request</button></div>
    {selection.log && <LogContent entry={selection.log} />}
    {!selection.traceId && <p className="request-inspector__muted">This log has no request context.</p>}
    {error && <p className="request-inspector__notice" role="alert">{error}</p>}
    {!current && loading && <p className="request-inspector__muted">Loading request…</p>}
    {current && <>
      <header className="request-inspector__heading"><h3>{current.request.name}</h3>
        <p>{current.request.status_code ?? (current.request.error ? 'Error' : 'Success')} · {formatMs(current.request.duration_ms)} · {current.spans.length} spans</p>
        <code>{selection.traceId}</code>
        {current.request.dropped_spans > 0 && <p className="request-inspector__notice">{current.request.dropped_spans} spans were not retained. This timeline is incomplete.</p>}
      </header>
      <section className="request-inspector__waterfall" aria-label="Request waterfall">
        <div className="request-inspector__axis"><span>0 ms</span><span>{formatMs(duration)}</span></div>
        {current.spans.map((item) => <button type="button" key={item.span_id}
          className={`request-inspector__span request-inspector__span--${item.layer}`} aria-pressed={item.span_id === span?.span_id}
          onClick={() => setSelectedSpan(item.span_id)} aria-label={`Inspect span ${item.service}: ${item.name}`}>
          <span className="request-inspector__span-label" style={{ paddingLeft: `${spanDepth(item, spansById) * 8}px` }}>{item.service} · {item.name}</span>
          <span className="request-inspector__track"><span className="request-inspector__bar" style={{ left: `${item.start_offset_ms / duration * 100}%`, width: `${item.duration_ms / duration * 100}%` }} /></span>
          <span className="request-inspector__timing">{formatMs(item.duration_ms)}{spanError(item) ? ' · error' : ''}</span>
          {clockSkew(item, spansById) && <span className="request-inspector__notice">Starts before its parent — clocks may differ.</span>}
        </button>)}
      </section>
      {span && <SpanContent span={span} />}
    </>}
  </section>
}

export default RequestInspector
