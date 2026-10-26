// Types
import type { BodyKindView } from '../api/generated/BodyKindView'
import type { LogEntryView } from '../api/generated/LogEntryView'
import type { PacketView } from '../api/generated/PacketView'
import type { LucideIcon } from './icons/lucideIcons'

/** One icon on the map: what it shows, in which colour, with an optional corner badge and a short label. */
export type Glyph = { icon: LucideIcon; color: string; badge: LucideIcon | null; label: string | null }

export const PACKET_COLORS = {
  request: '#7dcfff',
  response: '#73daca',
  error: '#f7768e',
  badge: '#e0af68',
  sql: { SELECT: '#7aa2f7', INSERT: '#9ece6a', UPDATE: '#e0af68', DELETE: '#ff9e64' } as Record<string, string>,
  sqlOther: '#bb9af7',
  level: { trace: '#565f89', debug: '#a9b1d6', info: '#7dcfff', warn: '#e0af68', error: '#f7768e', fatal: '#f7768e' },
  action: '#bb9af7',
  grpc: '#bb9af7',
} as const

/** How long a log record or user action stays at its node. */
export const FLASH_MS = 1_200
/** The part of an edge icons travel on, so they never hide under a node box. */
const TRACK_START = 0.08
const TRACK_END = 0.92

export function bodyIcon(body: BodyKindView): LucideIcon {
  switch (body) {
    case 'json':
      return 'file-braces'
    case 'form':
    case 'text':
      return 'file-text'
    case 'binary':
      return 'file-digit'
    case 'none':
      return 'file'
  }
}

export function sqlColor(operation: string | null): string {
  return (operation && PACKET_COLORS.sql[operation]) || PACKET_COLORS.sqlOther
}

const lock = (packet: PacketView) => (packet.kind === 'https' ? 'lock' : null)

/** The request on its way to the callee: a document with its body type and method, or a query by operation. */
export function requestGlyph(packet: PacketView): Glyph {
  if (packet.kind === 'sql') return { icon: 'database', color: sqlColor(packet.operation), badge: null, label: packet.operation }
  if (packet.kind === 'grpc') return { icon: 'file-digit', color: PACKET_COLORS.grpc, badge: null, label: 'gRPC' }
  return { icon: bodyIcon(packet.request_body), color: PACKET_COLORS.request, badge: lock(packet), label: packet.operation }
}

/** The response on its way back with its status code; red with a crossed document when the call failed. */
export function responseGlyph(packet: PacketView): Glyph {
  const status = packet.kind === 'grpc' ? packet.rpc_status : packet.status_code === null ? null : String(packet.status_code)
  if (packet.error) return { icon: 'file-x', color: PACKET_COLORS.error, badge: lock(packet), label: status ?? 'error' }
  if (packet.kind === 'sql') return { icon: 'rows-3', color: sqlColor(packet.operation), badge: null, label: null }
  if (packet.kind === 'grpc') return { icon: 'file-digit', color: PACKET_COLORS.response, badge: null, label: status ?? '?' }
  return { icon: bodyIcon(packet.response_body), color: PACKET_COLORS.response, badge: lock(packet), label: status }
}

/**
 * Where a pulse's icon is at `progress` (0–1 of its screen time): the request travels out until `outbound`, waits at
 * the callee until `inbound`, then the response travels back. `t` is the position along the edge, 0 at the caller.
 */
export function packetPhase(progress: number, outbound: number, inbound: number): { side: 'request' | 'response'; t: number } {
  const along = (share: number) => TRACK_START + (TRACK_END - TRACK_START) * Math.min(Math.max(share, 0), 1)
  if (progress < outbound) return { side: 'request', t: along(progress / outbound) }
  if (progress <= inbound) return { side: 'request', t: along(1) }
  return { side: 'response', t: along(1 - (progress - inbound) / (1 - inbound)) }
}

/** The icon a log record or user action shows at its node; spans show none (they travel as packets). */
export function flashGlyph(entry: LogEntryView): Glyph | null {
  if (entry.kind === 'action') {
    // The web SDK writes `<click|submit|navigate> <label>`; only the verb is shown.
    const verb = entry.text.split(' ', 1)[0] ?? ''
    const icon = verb === 'submit' ? 'send' : verb === 'navigate' ? 'navigation' : 'mouse-pointer-click'
    // No label: a click and the submit it causes flash side by side, and the icons tell them apart.
    return { icon, color: PACKET_COLORS.action, badge: null, label: null }
  }
  if (entry.kind === 'log') {
    const level = entry.level ?? 'info'
    return { icon: 'scroll-text', color: PACKET_COLORS.level[level], badge: null, label: level }
  }
  return null
}

/** Short label for the end-to-end test and the map summary: `http:POST`, `https:GET`, `sql:INSERT`. */
export function packetName(packet: PacketView | null): string {
  return packet ? `${packet.kind}:${packet.operation ?? '?'}` : 'unknown'
}

/** What the legend explains, in reading order. */
export const LEGEND: { glyph: Glyph; text: string }[] = [
  { glyph: { icon: 'file', color: PACKET_COLORS.request, badge: null, label: 'GET' }, text: 'HTTP request without a body' },
  { glyph: { icon: 'file-braces', color: PACKET_COLORS.request, badge: null, label: 'POST' }, text: 'JSON body' },
  { glyph: { icon: 'file-text', color: PACKET_COLORS.request, badge: null, label: null }, text: 'Form or text body' },
  { glyph: { icon: 'file-digit', color: PACKET_COLORS.request, badge: null, label: null }, text: 'Binary body' },
  { glyph: { icon: 'file', color: PACKET_COLORS.request, badge: 'lock', label: null }, text: 'HTTPS' },
  { glyph: { icon: 'file-digit', color: PACKET_COLORS.grpc, badge: null, label: 'gRPC' }, text: 'gRPC call; response shows RPC status' },
  { glyph: { icon: 'file-braces', color: PACKET_COLORS.response, badge: null, label: '200' }, text: 'Response on its way back' },
  { glyph: { icon: 'file-x', color: PACKET_COLORS.error, badge: null, label: '500' }, text: 'Failed call' },
  { glyph: { icon: 'database', color: PACKET_COLORS.sql.SELECT!, badge: null, label: 'SELECT' }, text: 'SQL query; colour by operation' },
  { glyph: { icon: 'rows-3', color: PACKET_COLORS.sql.SELECT!, badge: null, label: null }, text: 'Query result' },
  { glyph: { icon: 'scroll-text', color: PACKET_COLORS.level.warn, badge: null, label: 'warn' }, text: 'Log record; colour by level' },
  { glyph: { icon: 'mouse-pointer-click', color: PACKET_COLORS.action, badge: null, label: null }, text: 'User action: click, submit, navigate' },
]
