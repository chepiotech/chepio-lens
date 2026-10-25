// Components
import { AttributeList } from './SpanContent'
// Types
import type { LogEntryView } from '../../api/generated/LogEntryView'
// Utils
import { attribute } from './requestDetails'
import { logTime } from '../../logs/logState'

function LogContent({ entry }: { entry: LogEntryView }) {
  const record = entry.record
  if (!record) return null
  const redactions = attribute(record.attributes, 'lens.redaction.count')
  return <section className="request-inspector__content" aria-label="Log record">
    <h3>{entry.kind === 'action' ? 'User action' : 'Application log'}</h3>
    <p>{entry.service} · {entry.level ?? 'unspecified level'} · {logTime(entry.time)}</p>
    {record.truncated && <p className="request-inspector__notice">Log truncated — only the captured portion is available.</p>}
    {redactions && redactions !== '0' && <p>{redactions} values redacted</p>}
    <pre>{record.body}</pre>
    {record.attributes.length > 0 && <details open><summary>Log attributes</summary><AttributeList attributes={record.attributes} /></details>}
  </section>
}

export default LogContent
