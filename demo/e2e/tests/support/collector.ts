// Core
import type { APIRequestContext, Page } from '@playwright/test'

// Fixed by demo/compose.yaml; the demo origin is in the collector's default CORS list. `E2E_DEMO_URL` and
// `E2E_LENS_URL` point a run at another stack, e.g. dev servers beside a demo stack someone else is using.
export const DEMO = process.env.E2E_DEMO_URL ?? 'http://localhost:5173'
export const LENS = process.env.E2E_LENS_URL ?? 'http://localhost:4320'

/** Switches the open logs panel to lines; it opens on actions (ADR-0016). */
export async function showLogLines(page: Page) {
  await page.getByRole('group', { name: 'View' }).getByRole('button', { name: 'Lines', exact: true }).click()
}

export async function openLogLines(page: Page) {
  await page.getByRole('button', { name: 'Console', exact: true }).click()
  await showLogLines(page)
}

async function spansReceived(request: APIRequestContext): Promise<number> {
  const stats = (await (await request.get(`${LENS}/api/stats`)).json()) as { spans_received: number }
  return stats.spans_received
}

/** Waits until no spans have arrived for 1.5 s, so earlier batches cannot land after a reset. */
export async function waitForQuiet(request: APIRequestContext) {
  let previous = -1
  for (let i = 0; i < 20; i += 1) {
    const received = await spansReceived(request)
    if (received === previous) return
    previous = received
    await new Promise((resolve) => setTimeout(resolve, 1_500))
  }
  throw new Error('spans kept arriving for 30 s')
}
