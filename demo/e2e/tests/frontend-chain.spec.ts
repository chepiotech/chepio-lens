// Core
import { expect, test, type APIRequestContext } from '@playwright/test'

// Fixed by demo/compose.yaml; the demo origin is in the collector's default CORS list.
const DEMO = 'http://localhost:5173'
const LENS = 'http://localhost:4320'
/** Request end → visible on the map (docs/architecture/quality-attributes.md). */
const BUDGET_MS = 2_000

async function spansReceived(request: APIRequestContext): Promise<number> {
  const stats = (await (await request.get(`${LENS}/api/stats`)).json()) as { spans_received: number }
  return stats.spans_received
}

/** Waits until no spans have arrived for 1.5 s, so earlier batches cannot land after a reset. */
async function waitForQuiet(request: APIRequestContext) {
  let previous = -1
  for (let i = 0; i < 20; i += 1) {
    const received = await spansReceived(request)
    if (received === previous) return
    previous = received
    await new Promise((resolve) => setTimeout(resolve, 1_500))
  }
  throw new Error('spans kept arriving for 30 s')
}

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
  await expect(map.getByRole('status')).toHaveText('Live')
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
  test.info().annotations.push({ type: 'visible after', description: `${visibleMs} ms` })
  expect(visibleMs, 'request end → visible on the map').toBeLessThanOrEqual(BUDGET_MS)

  // The request's batches arrive separately; the map still animates it exactly once.
  await expect(canvas).toHaveAttribute('data-animated-requests', '1', { timeout: 5_000 })
  await map.waitForTimeout(2_500)
  await expect(canvas).toHaveAttribute('data-animated-requests', '1')
})
