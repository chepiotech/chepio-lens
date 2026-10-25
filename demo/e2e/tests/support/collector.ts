// Core
import type { APIRequestContext } from '@playwright/test'

// Fixed by demo/compose.yaml; the demo origin is in the collector's default CORS list.
export const DEMO = 'http://localhost:5173'
export const LENS = 'http://localhost:4320'

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
