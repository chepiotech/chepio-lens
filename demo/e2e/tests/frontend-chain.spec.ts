// Core
import { expect, test } from '@playwright/test'
// Utils
import { DEMO, LENS, waitForQuiet } from './support/collector'

/** Request end → visible on the map (docs/architecture/quality-attributes.md). */
const BUDGET_MS = 2_000

// The frontend slice is done when one click in the demo shows the whole chain on the map, animated.
test('one click in the demo shows web → api → postgres on the map, animated once', async ({ context, request }) => {
  const demo = await context.newPage()
  await demo.goto(DEMO)
  await expect(demo.getByRole('heading', { name: 'Notes' })).toBeVisible()
  // The page load itself is traced (two GETs in dev); let it settle, then start from an empty map.
  await waitForQuiet(request)
  expect((await request.post(`${LENS}/api/reset`)).status()).toBe(204)

  const map = await context.newPage()
  await map.goto(LENS)
  await map.getByRole('button', { name: 'Settings', exact: true }).click()
  await expect(map.getByRole('status')).toHaveText('Live')
  await map.getByRole('button', { name: 'Close settings' }).click()
  const summary = map.getByRole('region', { name: 'Map as text' })
  const canvas = map.locator('canvas')

  const text = `browser e2e ${Date.now()}`
  await demo.getByRole('textbox', { name: 'Note text' }).fill(text)
  const clickedAt = Date.now()
  await demo.getByRole('button', { name: 'Add', exact: true }).click()
  await expect(demo.getByText(text)).toBeVisible()

  await expect(summary).toContainText('demo-web → demo-api: 1 call, 0 errors', { timeout: 5_000 })
  await expect(summary).toContainText('demo-api → postgresql demo: 1 call, 0 errors', { timeout: 5_000 })
  const visibleMs = Date.now() - clickedAt
  await expect(summary).toContainText('demo-web (frontend)')
  await expect(summary).toContainText('technologies: React')
  await expect(summary).toContainText('technologies: Rust, axum, SQLx, Tokio')
  await expect(summary).toContainText('Pages: PAGE /')
  test.info().annotations.push({ type: 'visible after', description: `${visibleMs} ms` })
  expect(visibleMs, 'request end → visible on the map').toBeLessThanOrEqual(BUDGET_MS)

  // The request's batches arrive separately; the map still animates it exactly once.
  await expect(canvas).toHaveAttribute('data-animated-requests', '1', { timeout: 5_000 })
  // Each hop carries what travelled: the JSON POST to the API, then the INSERT into Postgres (packet icons).
  await expect(canvas).toHaveAttribute('data-last-packets', 'http:POST sql:INSERT')
  await map.waitForTimeout(2_500)
  await expect(canvas).toHaveAttribute('data-animated-requests', '1')
})

test('the arrow recovers after an error and shows the last call instead of session p95', async ({ page, request }) => {
  const lens = test.info().project.use.baseURL ?? LENS
  const otlp = test.info().config.metadata.otlpUrl ?? 'http://localhost:4318'
  expect((await request.post(`${lens}/api/reset`)).status()).toBe(204)
  await page.addInitScript(() => {
    const target = window as unknown as { edgeLabels: Record<string, { text: string; color: string; stroke: string }> }
    target.edgeLabels = {}
    const fillText = CanvasRenderingContext2D.prototype.fillText
    CanvasRenderingContext2D.prototype.fillText = function (...args: Parameters<typeof fillText>) {
      if (args[0].startsWith('HTTP · Last ')) {
        target.edgeLabels.latest = { text: args[0], color: String(this.fillStyle), stroke: String(this.strokeStyle) }
      } else if (/^\d+ calls?$/.test(args[0])) {
        target.edgeLabels.calls = { text: args[0], color: String(this.fillStyle), stroke: String(this.strokeStyle) }
      }
      return fillText.apply(this, args)
    }
  })
  await page.goto(lens)
  await page.getByRole('button', { name: 'Settings', exact: true }).click()
  await expect(page.getByRole('status')).toHaveText('Live')
  await page.getByRole('button', { name: 'Close settings' }).click()

  const send = async (id: number, startMs: number, durationMs: number, error: boolean) => {
    const start = 1_760_000_000_000_000_000n + BigInt(startMs) * 1_000_000n
    const end = start + BigInt(Math.round(durationMs * 1_000_000))
    const traceId = id.toString(16).padStart(32, '0')
    const resource = (service: string, kind: number, spanId: string, parentSpanId?: string) => ({
      resource: { attributes: [
        { key: 'service.name', value: { stringValue: service } },
        { key: 'lens.node.kind', value: { stringValue: kind === 3 ? 'frontend' : 'service' } },
      ] },
      scopeSpans: [{ spans: [{
        traceId, spanId, parentSpanId, kind, name: 'GET /example',
        startTimeUnixNano: start.toString(), endTimeUnixNano: end.toString(),
        status: { code: error ? 2 : 1 },
        attributes: [{ key: 'http.response.status_code', value: { intValue: error ? '500' : '200' } }],
      }] }],
    })
    const response = await request.post(`${otlp}/v1/traces`, { data: { resourceSpans: [
      resource('example-web', 3, '0000000000000001'),
      resource('example-api', 2, '0000000000000002', '0000000000000001'),
    ] } })
    expect(response.status()).toBe(200)
  }
  const painted = () => page.evaluate(() => (window as unknown as {
    edgeLabels: Record<string, { text: string; color: string; stroke: string }>
  }).edgeLabels).then((labels) => labels.latest ? { ...labels.latest, text: `${labels.latest.text} · ${labels.calls?.text}` } : undefined)
  const summary = page.getByRole('region', { name: 'Map as text' })

  await send(1, 0, 700, true)
  await expect.poll(painted).toEqual({ text: 'HTTP · Last 700 ms · error · 1 call', color: '#f7768e', stroke: '#f7768e' })
  await send(2, 1_000, 0.06, false)
  await expect(summary).toContainText('2 calls, 1 errors')
  await expect.poll(async () => (await painted())?.text).toBe('HTTP · Last 0.06 ms · 2 calls')
  expect((await painted())?.color).not.toBe('#f7768e')
  expect((await painted())?.stroke).not.toBe('#f7768e')
  // An older failure arriving after recovery still contributes to history, but cannot restore stale status.
  await send(3, 100, 2, true)
  await expect(summary).toContainText('3 calls, 2 errors')
  await expect.poll(async () => (await painted())?.text).toBe('HTTP · Last 0.06 ms · 3 calls')
  expect((await painted())?.color).not.toBe('#f7768e')
  expect((await painted())?.stroke).not.toBe('#f7768e')

  await send(4, 2_000, 2, true)
  await expect.poll(painted).toEqual({ text: 'HTTP · Last 2.0 ms · error · 4 calls', color: '#f7768e', stroke: '#f7768e' })

  // A graph snapshot requested at connection time can finish after a newer successful SSE event.
  let releaseSnapshot: () => void = () => {}
  const delayed = new Promise<void>((resolve) => { releaseSnapshot = resolve })
  let captured = false
  await page.route('**/api/graph', async (route) => {
    const response = await route.fetch()
    captured = true
    await delayed
    await route.fulfill({ response })
  })
  await page.reload()
  await expect.poll(() => captured).toBe(true)
  await send(5, 3_000, 0.06, false)
  await expect(summary).toContainText('5 calls, 3 errors')
  const snapshotReceived = page.waitForResponse('**/api/graph')
  releaseSnapshot()
  await (await snapshotReceived).finished()
  await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))))
  expect((await painted())?.text).toBe('HTTP · Last 0.06 ms · 5 calls')
  expect((await painted())?.stroke).not.toBe('#f7768e')
})
