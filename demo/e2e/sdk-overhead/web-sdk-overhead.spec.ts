// Core
import { createServer } from 'node:net'
import { expect, test, type APIRequestContext, type Browser, type CDPSession } from '@playwright/test'
// Domain
import { KINDS } from '../../web/src/sdkOverhead/benchRequests'
import { isMode, MODES, type Mode } from '../../web/src/sdkOverhead/benchModes'
// Types
import type { Plan } from '../../web/src/sdkOverhead/loadGenerator'
import type { SdkOverheadBench } from '../../web/src/sdkOverhead/sdkOverheadMain'
// Utils
import {
  deltaOverRounds,
  latencyQuantile,
  report,
  requestCount,
  type Round,
  type SlotStats,
} from '../../web/src/sdkOverhead/overheadStats'

// Ports from playwright.sdk-overhead.config.ts.
const BENCH = 'http://127.0.0.1:5186/sdk-overhead.html'
const COLLECTOR = 'http://127.0.0.1:34318'
const COLLECTOR_UI = 'http://127.0.0.1:34320'
/** Budget for the added latency per fetch at p95 (docs/architecture/quality-attributes.md). */
const BUDGET_MS = 1
const WARM_UP_SECONDS = 2
/** Page load, CDP and the SDK flush around each slot, for the test timeout. */
const SLOT_OVERHEAD_SECONDS = 5

/** `SDK_OVERHEAD_<name>` from the environment, as the Rust bench's flags. */
function setting(name: string, fallback: number): number {
  const value = process.env[`SDK_OVERHEAD_${name}`]
  if (value === undefined) return fallback
  const parsed = Number(value)
  if (!Number.isFinite(parsed) || parsed <= 0) throw new Error(`SDK_OVERHEAD_${name}=${value} is not a positive number`)
  return parsed
}

const PLAN: Plan = { rate: setting('RATE', 100), workers: setting('WORKERS', 4), seconds: setting('SECONDS', 10) }
const ROUNDS = setting('ROUNDS', 10)
const MODES_RUN: Mode[] = (process.env.SDK_OVERHEAD_MODES?.split(',') ?? [...MODES]).map((name) => {
  if (!isMode(name.trim())) throw new Error(`SDK_OVERHEAD_MODES: unknown mode ${name}`)
  return name.trim() as Mode
})

type BenchWindow = { sdkOverhead: SdkOverheadBench }
type Counters = Record<
  'spans_received' | 'spans_rejected' | 'spans_dropped' | 'batches_malformed' | 'batches_busy',
  number
>

/** An endpoint nothing listens at: a port taken from the OS and released at once. */
async function closedEndpoint(): Promise<string> {
  const server = createServer()
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  await new Promise((resolve) => server.close(resolve))
  if (address === null || typeof address === 'string') throw new Error('no port')
  return `http://127.0.0.1:${address.port}`
}

async function counters(request: APIRequestContext): Promise<Counters> {
  return (await request.get(`${COLLECTOR_UI}/api/stats`)).json()
}

/** Main-thread task time of the page so far, in seconds. */
async function taskSeconds(cdp: CDPSession): Promise<number> {
  const { metrics } = await cdp.send('Performance.getMetrics')
  const task = metrics.find((metric) => metric.name === 'TaskDuration')
  if (!task) throw new Error('Chromium reports no TaskDuration')
  return task.value
}

/** Modes whose spans reach the bench's collector. */
const exports = (mode: Mode) => mode === 'spans' || mode === 'bodies'

/** One slot in a fresh browser context: warm-up, measurement, flush. `sent` counts both parts. */
async function measureSlot(browser: Browser, mode: Mode, endpoint: string, plan: Plan) {
  const context = await browser.newContext()
  try {
    const page = await context.newPage()
    const pageErrors: Error[] = []
    page.on('pageerror', (error) => pageErrors.push(error))
    await page.goto(`${BENCH}?${new URLSearchParams({ mode, endpoint })}`)
    await page.waitForFunction(() => 'sdkOverhead' in window)
    const isolated = await page.evaluate(() => (window as unknown as BenchWindow).sdkOverhead.crossOriginIsolated)
    expect(isolated, 'cross-origin isolation, for 5 µs timer resolution').toBe(true)
    const cdp = await context.newCDPSession(page)
    await cdp.send('Performance.enable')
    const run = (slotPlan: Plan) =>
      page.evaluate((runPlan) => (window as unknown as BenchWindow).sdkOverhead.run(runPlan), slotPlan)

    const warmUp = await run({ ...plan, seconds: WARM_UP_SECONDS })
    const before = await taskSeconds(cdp)
    const measured = await run(plan)
    const taskMs = ((await taskSeconds(cdp)) - before) * 1_000
    // Flushed only where spans can arrive, so the collector's count below is complete.
    if (exports(mode)) await page.evaluate(() => (window as unknown as BenchWindow).sdkOverhead.finish())
    expect(pageErrors.map(String), 'errors in the bench page').toEqual([])
    const slot: SlotStats = { ...measured, taskMs }
    return { slot, sent: requestCount({ ...warmUp, taskMs: 0 }) + requestCount(slot) }
  } finally {
    await context.close()
  }
}

test('the web SDK adds at most 1 ms at p95 to a fetch and never fails one', async ({ browser, request }) => {
  test.setTimeout(
    (MODES_RUN.length * ROUNDS + 1) * (WARM_UP_SECONDS + PLAN.seconds + SLOT_OVERHEAD_SECONDS) * 1_000 + 60_000,
  )
  const unreachable = await closedEndpoint()
  const endpoint = (mode: Mode) => ({ off: '', spans: COLLECTOR, bodies: COLLECTOR, unreachable })[mode]

  // A slot that is thrown away: the first load of the SDK through the dev server is slower than the others.
  await measureSlot(browser, 'bodies', COLLECTOR, PLAN)
  const rounds: Round[] = []
  for (let index = 0; index < ROUNDS; index += 1) {
    const round: Round = {}
    // Each round starts with the next mode, so no mode always runs first or last.
    for (let offset = 0; offset < MODES_RUN.length; offset += 1) {
      const mode = MODES_RUN[(offset + index) % MODES_RUN.length] ?? 'off'
      console.error(`round ${index + 1} of ${ROUNDS}: ${mode}`)
      const start = await counters(request)
      const { slot, sent } = await measureSlot(browser, mode, endpoint(mode), PLAN)
      const end = await counters(request)

      // Every span of an exporting slot reached the collector and was stored; the other modes sent none there.
      expect(end.spans_received - start.spans_received, `${mode}: spans received`).toBe(exports(mode) ? sent : 0)
      for (const key of ['spans_rejected', 'spans_dropped', 'batches_malformed', 'batches_busy'] as const) {
        expect(end[key] - start[key], `${mode}: ${key}`).toBe(0)
      }
      round[mode] = slot
    }
    rounds.push(round)
  }

  console.log(`\n${report(rounds, MODES_RUN, PLAN)}\n`)
  for (const mode of MODES_RUN) {
    const errors = rounds.reduce((sum, round) => sum + (round[mode]?.errors ?? 0), 0)
    expect(errors, `${mode}: failed requests`).toBe(0)
    if (mode === 'off' || !MODES_RUN.includes('off')) continue
    const added = deltaOverRounds(rounds, mode, 'off', latencyQuantile(KINDS, 0.95))
    expect(added, `${mode}: added latency at p95, ms`).toBeLessThanOrEqual(BUDGET_MS)
  }
})
