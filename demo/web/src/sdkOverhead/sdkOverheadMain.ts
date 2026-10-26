// Web SDK overhead bench (docs/architecture/quality-attributes.md, "Added latency per fetch in the browser").
// Development only: `sdk-overhead.html` is not a build input, so production builds never contain it. Driven by
// `pnpm --filter demo-e2e sdk-overhead`, which loads the page once per mode and slot with `?mode=…&endpoint=…`
// and calls `window.sdkOverhead`.

// Core
import type { Lens } from 'chepio-lens-web'
// Domain
import { benchRequest, type Kind } from './benchRequests'
import { isMode, lensOptions, type Mode } from './benchModes'
// Services
import { type Plan, pageClock, runSlot, type SlotResult } from './loadGenerator'

export type SdkOverheadBench = {
  mode: Mode
  /** `performance.now()` resolves to 5 µs only in a cross-origin isolated page, 100 µs otherwise. */
  crossOriginIsolated: boolean
  /** Sends the plan's load; long tasks are the main thread's tasks over 50 ms during it. */
  run(plan: Plan): Promise<SlotResult & { longTasks: number }>
  /** Waits for the last spans to end, then flushes the SDK, so every span of the slot reaches the collector. */
  finish(): Promise<void>
}

/** The fetch instrumentation ends a span 300 ms after its response; this leaves room for that. */
const SPAN_END_WAIT_MS = 1_000

// As the demo calls its API (`demoApi.ts`): the answer is read to its end.
async function send(kind: Kind, note: number): Promise<boolean> {
  const { url, init } = benchRequest(kind, note)
  const response = await fetch(url, init)
  await response.json()
  return response.ok
}

async function run(plan: Plan) {
  let longTasks = 0
  const observer = new PerformanceObserver((list) => {
    longTasks += list.getEntries().length
  })
  observer.observe({ type: 'longtask' })
  try {
    return { ...(await runSlot(plan, send, pageClock)), longTasks }
  } finally {
    observer.disconnect()
  }
}

const params = new URLSearchParams(location.search)
const mode = params.get('mode')
if (!isMode(mode)) throw new Error(`unknown mode ${JSON.stringify(mode)}`)
const options = lensOptions(mode, params.get('endpoint') ?? '')
let lens: Lens | null = null
if (options) {
  const { initLens } = await import('chepio-lens-web')
  lens = initLens(options)
  if (!lens.enabled) throw new Error('the SDK did not start')
}

const bench: SdkOverheadBench = {
  mode,
  crossOriginIsolated,
  run,
  finish: async () => {
    await pageClock.sleep(SPAN_END_WAIT_MS)
    await lens?.shutdown()
  },
}
;(window as unknown as { sdkOverhead: SdkOverheadBench }).sdkOverhead = bench
