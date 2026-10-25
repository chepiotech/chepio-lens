// Core
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
// Components
import SpanContent from './SpanContent'
// Types
import type { AttributeView } from '../../api/generated/AttributeView'
import type { SpanView } from '../../api/generated/SpanView'
// Utils
import { bodyContent, clockSkew, spanDepth, spanError } from './requestDetails'

const attr = (key: string, value: string): AttributeView => ({ key, kind: 'string', values: [value] })
const span = (id: string, parent: string | null, offset: number): SpanView => ({
  span_id: id, parent_span_id: parent, service: 'api', layer: 'backend', kind: 'server', name: 'POST /example',
  start: '1', start_offset_ms: offset, duration_ms: 1, status: 'ok', status_message: null,
  attributes: [], events: [], truncated_attributes: [],
})

describe('request detail presentation', () => {
  it('shows HTTP failures even when an exporter leaves the span status unset', () => {
    const value = span('a', null, 0)
    value.status = 'unset'
    value.attributes = [attr('http.response.status_code', '503')]
    expect(spanError(value)).toBe(true)
    expect(renderToStaticMarkup(<SpanContent span={value} />)).toContain('HTTP 503')
  })
  it('formats valid JSON and distinguishes unmasked invalid JSON from truncation and full redaction', () => {
    const type = attr('http.request.header.content-type', 'application/problem+json; charset=utf-8')
    const body = (value: string) => attr('lens.http.request.body', value)
    expect(bodyContent([type, body('{"ok":true}')], [], 'request').text).toBe('{\n  "ok": true\n}')
    expect(bodyContent([type, body('{broken')], [], 'request').invalidJson).toBe(true)
    expect(bodyContent([type, body('[REDACTED]')], ['lens.http.request.body'], 'request')).toEqual({ text: '[REDACTED]', invalidJson: false, truncated: true })
    expect(bodyContent([type, body('{broken'), attr('lens.http.request.body.truncated', 'true')], [], 'request').invalidJson).toBe(false)
  })

  it('keeps headers, bodies, SQL and exception attributes as literal text', () => {
    const payload = '<img src=x onerror=alert(1)>'
    const value = span('a', null, 0)
    value.attributes = [attr('http.response.header.example', payload), attr('lens.http.response.body', payload), attr('db.query.text', payload)]
    value.events = [{ name: 'exception', offset_ms: 1, attributes: [attr('exception.message', payload)], truncated_attributes: ['exception.message'] }]
    const html = renderToStaticMarkup(<SpanContent span={value} />)
    expect(html).not.toContain('<img')
    expect(html).toContain('&lt;img')
    expect(html).toContain('Truncated: exception.message')
  })

  it('flags clock skew without moving spans and handles missing or cyclic parents', () => {
    const parent = span('a', null, 4)
    const child = span('b', 'a', 1)
    const byId = new Map([parent, child].map((item) => [item.span_id, item]))
    expect(clockSkew(child, byId)).toBe(true)
    expect(child.start_offset_ms).toBe(1)
    expect(spanDepth(child, byId)).toBe(1)
    expect(spanDepth(child, new Map([[child.span_id, child]]))).toBe(0)
    parent.parent_span_id = child.span_id
    expect(spanDepth(child, byId)).toBe(1)
  })
})
