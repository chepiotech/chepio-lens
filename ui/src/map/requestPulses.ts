// Types
import type { HopView } from '../api/generated/HopView'

/** Shortest time a hop stays on screen, so a 1 ms query is still visible. */
export const MIN_HOP_MS = 300
/** Longest a whole request animates; slower requests are compressed to fit. */
export const MAX_REQUEST_MS = 3_000

/** One dot travelling along an edge: starts `delayMs` after the request is shown and takes `durationMs`. */
export type Pulse = { edgeId: string; delayMs: number; durationMs: number }

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
  }))
}
