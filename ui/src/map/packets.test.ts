// Core
import { describe, expect, it } from 'vitest'
// Types
import type { LogEntryView } from '../api/generated/LogEntryView'
import type { PacketView } from '../api/generated/PacketView'
// Utils
import { lucideIcons } from './icons/lucideIcons'
import { LEGEND, PACKET_COLORS, flashGlyph, packetName, packetPhase, requestGlyph, responseGlyph } from './packets'

const http = (overrides: Partial<PacketView> = {}): PacketView => ({
  kind: 'http', operation: 'POST', request_body: 'json', response_body: 'json', status_code: 201, rpc_status: null, error: false, ...overrides,
})
const entry = (overrides: Partial<LogEntryView>): LogEntryView => ({
  id: '1', trace_id: null, span_id: null, time: '0', duration_ms: null, layer: 'frontend', kind: 'log', service: 'web',
  nodes: ['svc:web'], text: '', status_code: null, error: false, level: null, record: null, ...overrides,
})

describe('packet glyphs', () => {
  it('distinguishes gRPC from HTTP 200 and recovers on the next successful call', () => {
    const rpc = http({ kind: 'grpc', operation: 'school.Identity/GetUser', status_code: 200, rpc_status: 'INTERNAL', error: true })
    expect(requestGlyph(rpc)).toEqual({ icon: 'file-digit', color: PACKET_COLORS.grpc, badge: null, label: 'gRPC' })
    expect(responseGlyph(rpc)).toEqual({ icon: 'file-x', color: PACKET_COLORS.error, badge: null, label: 'INTERNAL' })
    expect(responseGlyph({ ...rpc, rpc_status: 'OK', error: false })).toEqual({
      icon: 'file-digit', color: PACKET_COLORS.response, badge: null, label: 'OK',
    })
    expect(responseGlyph({ ...rpc, rpc_status: null }).label).toBe('error')
    expect(responseGlyph({ ...rpc, rpc_status: null, error: false }).label).toBe('?')
    expect(packetName(rpc)).toBe('grpc:school.Identity/GetUser')
  })
  it('shows an HTTP document by body type with its method, and the response with its status', () => {
    expect(requestGlyph(http())).toEqual({ icon: 'file-braces', color: PACKET_COLORS.request, badge: null, label: 'POST' })
    expect(responseGlyph(http())).toEqual({ icon: 'file-braces', color: PACKET_COLORS.response, badge: null, label: '201' })
    expect(requestGlyph(http({ request_body: 'none', operation: 'GET' })).icon).toBe('file')
    expect(requestGlyph(http({ request_body: 'form' })).icon).toBe('file-text')
    expect(requestGlyph(http({ request_body: 'text' })).icon).toBe('file-text')
    expect(responseGlyph(http({ response_body: 'binary' })).icon).toBe('file-digit')
  })

  it('marks HTTPS with a lock on both ways', () => {
    const secure = http({ kind: 'https' })
    expect(requestGlyph(secure).badge).toBe('lock')
    expect(responseGlyph(secure).badge).toBe('lock')
  })

  it('shows a failed call as a red crossed document with its code', () => {
    expect(responseGlyph(http({ error: true, status_code: 500 }))).toEqual({
      icon: 'file-x', color: PACKET_COLORS.error, badge: null, label: '500',
    })
    expect(responseGlyph(http({ kind: 'sql', error: true, status_code: null })).label).toBe('error')
  })

  it('colours queries by operation and returns rows', () => {
    const query = http({ kind: 'sql', operation: 'DELETE', request_body: 'none', response_body: 'none', status_code: null })
    expect(requestGlyph(query)).toEqual({ icon: 'database', color: PACKET_COLORS.sql.DELETE, badge: null, label: 'DELETE' })
    expect(responseGlyph(query)).toEqual({ icon: 'rows-3', color: PACKET_COLORS.sql.DELETE, badge: null, label: null })
    expect(requestGlyph({ ...query, operation: 'WITH' }).color).toBe(PACKET_COLORS.sqlOther)
    expect(requestGlyph({ ...query, operation: null }).label).toBeNull()
  })

  it('names packets for the end-to-end test', () => {
    expect(packetName(http({ kind: 'https', operation: 'GET' }))).toBe('https:GET')
    expect(packetName(http({ kind: 'sql', operation: null }))).toBe('sql:?')
    expect(packetName(null)).toBe('unknown')
  })

  it('only uses icons that were imported from Lucide', () => {
    const used = LEGEND.flatMap(({ glyph }) => [glyph.icon, glyph.badge]).filter((icon) => icon !== null)
    for (const icon of used) expect(lucideIcons[icon].length).toBeGreaterThan(0)
  })
})

describe('packetPhase', () => {
  it('travels out, waits at the callee, then comes back, staying clear of the node boxes', () => {
    const at = (progress: number) => packetPhase(progress, 0.25, 0.75)
    expect(at(0)).toEqual({ side: 'request', t: 0.08 })
    expect(at(0.125).t).toBeCloseTo(0.5)
    expect(at(0.5)).toEqual({ side: 'request', t: 0.92 })
    expect(at(0.875)).toMatchObject({ side: 'response' })
    expect(at(0.875).t).toBeCloseTo(0.5)
    expect(at(1)).toEqual({ side: 'response', t: 0.08 })
  })
})

describe('flashGlyph', () => {
  it('flashes user actions by verb, never their labels', () => {
    expect(flashGlyph(entry({ kind: 'action', text: 'click Add note' }))).toMatchObject({ icon: 'mouse-pointer-click', label: null })
    expect(flashGlyph(entry({ kind: 'action', text: 'submit form' }))).toMatchObject({ icon: 'send', label: null })
    expect(flashGlyph(entry({ kind: 'action', text: 'navigate /notes' }))).toMatchObject({ icon: 'navigation', label: null })
  })

  it('flashes log records in their level colour and nothing for spans', () => {
    expect(flashGlyph(entry({ kind: 'log', level: 'warn' }))).toEqual({
      icon: 'scroll-text', color: PACKET_COLORS.level.warn, badge: null, label: 'warn',
    })
    expect(flashGlyph(entry({ kind: 'log', level: null }))?.label).toBe('info')
    expect(flashGlyph(entry({ kind: 'request' }))).toBeNull()
    expect(flashGlyph(entry({ kind: 'query' }))).toBeNull()
  })
})
