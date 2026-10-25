// Types
import type { RequestView } from '../api/generated/RequestView'

/** Wait after the last event of a request whose root span has arrived: catches a straggling batch. */
export const SETTLE_WITH_ROOT_MS = 300
/**
 * Wait while the root is missing. A browser span ends about 300 ms after its response and both SDKs export every
 * 500 ms, so the browser's batch can trail the API's by about 800 ms.
 */
export const SETTLE_WITHOUT_ROOT_MS = 1_200
/** Requests waiting at once; beyond it the oldest is handed over early. */
export const MAX_PENDING = 500
/** Requests remembered as shown, so a late event does not animate one again. */
export const MAX_SHOWN = 2_000

type Pending = { request: RequestView; timer: ReturnType<typeof setTimeout> }

/**
 * A request's spans arrive in several batches, each producing a `request` event. This hands each request over once,
 * with all its hops, after its events have settled.
 */
export class RequestSettler {
  private readonly pending = new Map<string, Pending>()
  private readonly shown = new Set<string>()

  private readonly onSettled: (request: RequestView) => void

  constructor(onSettled: (request: RequestView) => void) {
    this.onSettled = onSettled
  }

  push(request: RequestView) {
    const id = request.trace_id
    if (this.shown.has(id)) return
    const previous = this.pending.get(id)
    if (previous) {
      clearTimeout(previous.timer)
      this.pending.delete(id)
    } else if (this.pending.size >= MAX_PENDING) {
      const [oldest] = this.pending.keys()
      if (oldest !== undefined) this.settle(oldest)
    }
    const delay = request.has_root ? SETTLE_WITH_ROOT_MS : SETTLE_WITHOUT_ROOT_MS
    this.pending.set(id, { request, timer: setTimeout(() => this.settle(id), delay) })
  }

  /** Drops everything waiting and forgets what was shown, e.g. after the map is reset. */
  clear() {
    for (const { timer } of this.pending.values()) clearTimeout(timer)
    this.pending.clear()
    this.shown.clear()
  }

  private settle(id: string) {
    const entry = this.pending.get(id)
    if (!entry) return
    clearTimeout(entry.timer)
    this.pending.delete(id)
    this.shown.add(id)
    if (this.shown.size > MAX_SHOWN) {
      const [oldest] = this.shown
      if (oldest !== undefined) this.shown.delete(oldest)
    }
    this.onSettled(entry.request)
  }
}
