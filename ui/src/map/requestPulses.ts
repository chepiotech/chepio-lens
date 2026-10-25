// Types
import type { HopView } from '../api/generated/HopView'
import type { PacketView } from '../api/generated/PacketView'

/** Shortest time a hop stays on screen, so its request and response icons can be read even for a 1 ms query. */
export const MIN_HOP_MS = 900
/** Longest a whole request animates; slower requests are compressed to fit. */
export const MAX_REQUEST_MS = 3_000
/** Most of a hop's screen time the request takes to travel out, and the response to travel back. */
export const TRAVEL_SHARE = 0.35
/** Least of it, so a call that starts its own calls at once still shows its request moving. */
export const MIN_TRAVEL_SHARE = 0.12

/**
 * One hop on screen: starts `delayMs` after the request is shown and takes `durationMs`. The request icon arrives at
 * `outbound` (share of the duration) and the response leaves at `inbound`.
 */
export type Pulse = {
  edgeId: string
  delayMs: number
  durationMs: number
  packet: PacketView | null
  outbound: number
  inbound: number
}

/**
 * Turns a request's hops into screen time. One scale for the whole request keeps the order and overlap of the span
 * data: it stretches fast requests until the shortest hop lasts `MIN_HOP_MS`, but never beyond `MAX_REQUEST_MS` for the
 * whole request. A hop still shorter than `MIN_HOP_MS` after scaling is held for `MIN_HOP_MS`.
 */
export function pulsesFor(hops: HopView[]): Pulse[] {
  if (hops.length === 0) return []
  const total = Math.max(...hops.map((hop) => hop.start_offset_ms + hop.duration_ms))
  const shortest = Math.min(...hops.map((hop) => hop.duration_ms))
  const stretch = shortest > 0 ? MIN_HOP_MS / shortest : Number.POSITIVE_INFINITY
  const fit = total > 0 ? MAX_REQUEST_MS / total : Number.POSITIVE_INFINITY
  const scale = Math.min(stretch, fit)
  const factor = Number.isFinite(scale) ? scale : 1
  return hops.map((hop) => ({
    edgeId: hop.edge,
    delayMs: hop.start_offset_ms * factor,
    durationMs: Math.max(hop.duration_ms * factor, MIN_HOP_MS),
    packet: hop.packet,
    ...travel(hop, hops),
  }))
}

/**
 * The request arrives before the callee's own calls start and the response leaves after they end, so a query never
 * leaves the API before the browser's request has reached it. Calls inside a hop are the hops nested in its time.
 */
function travel(hop: HopView, hops: HopView[]): { outbound: number; inbound: number } {
  const end = hop.start_offset_ms + hop.duration_ms
  const inner = hops.filter((other) => {
    const otherEnd = other.start_offset_ms + other.duration_ms
    return other !== hop && other.start_offset_ms >= hop.start_offset_ms && otherEnd <= end &&
      (other.start_offset_ms > hop.start_offset_ms || otherEnd < end)
  })
  if (inner.length === 0 || hop.duration_ms <= 0) return { outbound: TRAVEL_SHARE, inbound: 1 - TRAVEL_SHARE }
  const share = (ms: number) => Math.min(Math.max(ms / hop.duration_ms, MIN_TRAVEL_SHARE), TRAVEL_SHARE)
  const firstStart = Math.min(...inner.map((other) => other.start_offset_ms))
  const lastEnd = Math.max(...inner.map((other) => other.start_offset_ms + other.duration_ms))
  return { outbound: share(firstStart - hop.start_offset_ms), inbound: 1 - share(end - lastEnd) }
}
