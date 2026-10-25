// Types
import type { AttributeView } from '../../api/generated/AttributeView'
import type { SpanView } from '../../api/generated/SpanView'

export function attribute(attributes: AttributeView[], key: string): string | undefined {
  return attributes.find((item) => item.key === key)?.values[0]
}

export function bodyContent(attributes: AttributeView[], truncatedKeys: string[], direction: 'request' | 'response') {
  const key = `lens.http.${direction}.body`
  const body = attribute(attributes, key)
  const truncated = attribute(attributes, `${key}.truncated`) === 'true' || truncatedKeys.includes(key)
  const contentType = attribute(attributes, `http.${direction}.header.content-type`)?.split(';')[0]?.trim().toLowerCase()
  const expectsJson = contentType === 'application/json' || contentType?.endsWith('+json')
  if (body === undefined) return { text: null, truncated, invalidJson: false }
  try { return { text: JSON.stringify(JSON.parse(body), null, 2), truncated, invalidJson: false } }
  catch { return { text: body, truncated, invalidJson: Boolean(expectsJson && !truncated && body !== '[REDACTED]') } }
}

export function clockSkew(span: SpanView, spans: ReadonlyMap<string, SpanView>): boolean {
  const parent = span.parent_span_id ? spans.get(span.parent_span_id) : undefined
  return Boolean(parent && span.start_offset_ms < parent.start_offset_ms)
}

/** Matches the collector's span error rule, including exporters that only set an HTTP status. */
export function spanError(span: SpanView): boolean {
  return span.status === 'error' || Number(attribute(span.attributes, 'http.response.status_code')) >= 500
}

export function spanDepth(span: SpanView, byId: ReadonlyMap<string, SpanView>): number {
  const seen = new Set([span.span_id])
  let parent = span.parent_span_id ? byId.get(span.parent_span_id) : undefined
  let depth = 0
  while (parent && !seen.has(parent.span_id) && depth < 8) {
    seen.add(parent.span_id)
    depth += 1
    parent = parent.parent_span_id ? byId.get(parent.parent_span_id) : undefined
  }
  return Math.min(depth, 8)
}
