// Types
import type { AttributeView } from '../../api/generated/AttributeView'
import type { SpanView } from '../../api/generated/SpanView'
// Utils
import { attribute, bodyContent, spanError } from './requestDetails'
import { formatMs } from '../../map/formatMs'

function AttributeList({ attributes }: { attributes: AttributeView[] }) {
  return <dl className="request-inspector__attributes">{attributes.map((item) => <div key={item.key}>
    <dt>{item.key}</dt><dd><pre>{item.values.join('\n')}</pre></dd>
  </div>)}</dl>
}

function SpanContent({ span }: { span: SpanView }) {
  const redactions = attribute(span.attributes, 'lens.redaction.count')
  const sql = attribute(span.attributes, 'db.query.text')
  return <div className="request-inspector__content">
    <h3>{span.name}</h3>
    <p className="request-inspector__span-meta">{span.service} · {span.kind} · {formatMs(span.duration_ms)} · {span.status}</p>
    <div className="request-inspector__markers">
      {redactions && redactions !== '0' && <span>{redactions} values redacted</span>}
      {span.truncated_attributes.length > 0 && <span>Truncated: {span.truncated_attributes.join(', ')}</span>}
    </div>
    {spanError(span) && <section aria-label="Span error"><h4>Error</h4><pre>{span.status_message || attribute(span.attributes, 'error.type') || `The span reported an error${attribute(span.attributes, 'http.response.status_code') ? ` (HTTP ${attribute(span.attributes, 'http.response.status_code')})` : ''}.`}</pre></section>}
    {(['request', 'response'] as const).map((direction) => {
      const prefix = `http.${direction}.header.`
      const headers = span.attributes.filter((item) => item.key.startsWith(prefix)).map((item) => ({ ...item, key: item.key.slice(prefix.length) }))
      const body = bodyContent(span.attributes, span.truncated_attributes, direction)
      if (headers.length === 0 && body.text === null && !body.truncated) return null
      return <section key={direction} aria-label={`${direction} payload`}>
        <h4>{direction === 'request' ? 'Request' : 'Response'}</h4>
        {headers.length > 0 && <details open><summary>Headers</summary><AttributeList attributes={headers} /></details>}
        <h5>Body</h5>
        {body.truncated && <p className="request-inspector__notice">Body truncated — only the captured portion is available.</p>}
        {body.invalidJson && <p className="request-inspector__notice">Not valid JSON — keys could not be masked.</p>}
        {body.text !== null ? <pre>{body.text}</pre> : <p className="request-inspector__muted">Body not captured.</p>}
      </section>
    })}
    {sql !== undefined && <section aria-label="SQL query"><h4>SQL</h4><pre>{sql}</pre></section>}
    {span.events.length > 0 && <section aria-label="Span events"><h4>Events</h4>{span.events.map((event, index) => <details key={`${event.name}-${index}`} open={event.name === 'exception'}>
      <summary>{event.name} · {formatMs(event.offset_ms)} from span start</summary>
      {event.offset_ms < 0 && <p className="request-inspector__notice">Event timestamp precedes the span. Clocks may differ.</p>}
      {event.truncated_attributes.length > 0 && <p className="request-inspector__notice">Truncated: {event.truncated_attributes.join(', ')}</p>}
      <AttributeList attributes={event.attributes} />
    </details>)}</section>}
    <details><summary>All span attributes ({span.attributes.length})</summary><AttributeList attributes={span.attributes} /></details>
    <p className="request-inspector__muted">Span <code>{span.span_id}</code></p>
  </div>
}

export default SpanContent
