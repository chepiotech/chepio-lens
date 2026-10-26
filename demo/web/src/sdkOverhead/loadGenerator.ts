// Domain
import { KINDS, type Kind, NOTES } from './benchRequests'

export type Plan = { rate: number; workers: number; seconds: number }
/** Latency in ms of each successful request, per kind. */
export type Latencies = Record<Kind, number[]>
export type SlotResult = { latencies: Latencies; errors: number }
export type Clock = { now(): number; sleep(ms: number): Promise<void> }
/** Sends one request and reads its answer to the end; `false` or a throw counts as an error. */
export type Send = (kind: Kind, note: number) => Promise<boolean>

export const pageClock: Clock = {
  now: () => performance.now(),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
}

export function emptyLatencies(): Latencies {
  return { health: [], login: [], getNote: [], putNote: [], listNotes: [] }
}

/**
 * Sends `rate` requests per second for `seconds` from `workers` loops, each on a fixed schedule, as the Rust bench's
 * `run_slot` does. A request sent late because the previous answer was slow counts from its scheduled start, so the
 * delay is charged to the requests; one sent after a sleep counts from the wake-up, so a late timer in the page is
 * not. Each loop cycles through the kinds, offset by its index, so every kind runs alongside the others.
 */
export async function runSlot(plan: Plan, send: Send, clock: Clock): Promise<SlotResult> {
  const interval = (1_000 * plan.workers) / plan.rate
  const begin = clock.now()
  const deadline = begin + plan.seconds * 1_000
  const result: SlotResult = { latencies: emptyLatencies(), errors: 0 }
  const loop = async (worker: number) => {
    const start = begin + (interval * worker) / plan.workers
    for (let step = 0; ; step += 1) {
      const scheduled = start + interval * step
      if (scheduled >= deadline) return
      const kind = KINDS[(step + worker) % KINDS.length] ?? 'health'
      const note = ((step * plan.workers + worker) % NOTES) + 1
      let from = scheduled
      const now = clock.now()
      if (now < scheduled) {
        await clock.sleep(scheduled - now)
        from = clock.now()
      }
      let ok = false
      try {
        ok = await send(kind, note)
      } catch {
        // A failed request, counted below.
      }
      if (ok) result.latencies[kind].push(clock.now() - from)
      else result.errors += 1
    }
  }
  await Promise.all(Array.from({ length: plan.workers }, (_, worker) => loop(worker)))
  return result
}
