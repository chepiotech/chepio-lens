// Core
import { expect, test, type APIRequestContext, type BrowserContext, type Page } from '@playwright/test'
// Utils
import { DEMO, LENS, waitForQuiet } from './support/collector'

// The demo's fake credentials (demo/api/src/handlers.rs, demo/web/src/services/demoApi.ts). Masked by both SDKs before
// export and again by the collector (I2), so no response of the collector may contain them.
const SECRETS = ['demo-password', 'demo-session-token']
const MARKUP = '<img src=x onerror=alert(1)>'

type Line = { trace_id: string | null; layer: string; kind: string; text: string }

async function lines(request: APIRequestContext, query: string): Promise<Line[]> {
  const page = (await (await request.get(`${LENS}/api/logs?limit=100&q=${encodeURIComponent(query)}`)).json()) as { entries: Line[] }
  return page.entries
}

/**
 * Waits until both sides of the call are stored: the browser's fetch (`POST localhost:5173/api/…`) and the API's
 * server span (`POST /api/…`). Returns their trace ids.
 */
async function bothSides(request: APIRequestContext, method: string, path: string): Promise<string[]> {
  const calls = async () => (await lines(request, path))
    .filter((line) => line.kind === 'request' && line.text.startsWith(`${method} `))
  await expect.poll(async () => (await calls()).map((line) => line.layer).sort().join(','), { timeout: 10_000 })
    .toBe('backend,frontend')
  return [...new Set((await calls()).map((line) => line.trace_id).filter((id) => id !== null))]
}

/** Opens the demo with a quiet, empty collector; any dialog on any page fails the test (I11). */
async function start(context: BrowserContext, request: APIRequestContext): Promise<{ demo: Page; dialogs: string[] }> {
  const dialogs: string[] = []
  context.on('page', (page) => page.on('dialog', async (dialog) => { dialogs.push(dialog.message()); await dialog.dismiss() }))
  const demo = await context.newPage()
  await demo.goto(DEMO)
  await expect(demo.getByRole('heading', { name: 'Notes' })).toBeVisible()
  await waitForQuiet(request)
  expect((await request.post(`${LENS}/api/reset`)).status()).toBe(204)
  return { demo, dialogs }
}

async function inspect(context: BrowserContext, text: string) {
  const map = await context.newPage()
  await map.goto(LENS)
  await map.getByRole('button', { name: 'Logs', exact: true }).click()
  await map.getByRole('list', { name: 'Log entries' }).getByRole('button').filter({ hasText: 'backend' })
    .filter({ hasText: text }).first().click()
  return { map, inspector: map.getByRole('region', { name: 'Request inspector' }) }
}

// The demo's last batches (the clean-up's DELETE and reload) must land before the next file resets the collector.
test.afterEach(async ({ request }) => {
  await waitForQuiet(request)
})

test('a real demo login reaches the collector, its API and the inspector only masked (I2)', async ({ context, request }) => {
  const { demo, dialogs } = await start(context, request)

  await demo.getByRole('button', { name: 'Log in', exact: true }).click()
  const traces = await bothSides(request, 'POST', '/api/login')

  // Everything the collector serves about the session: the map, every log line, and each request's spans.
  const served = [await (await request.get(`${LENS}/api/graph`)).text(), await (await request.get(`${LENS}/api/logs?limit=500`)).text()]
  for (const trace of traces) served.push(await (await request.get(`${LENS}/api/requests/${trace}`)).text())
  const all = served.join('\n')
  expect(all).toContain('[REDACTED]')
  for (const secret of SECRETS) expect(all, `${secret} reached the collector`).not.toContain(secret)

  const { map, inspector } = await inspect(context, '/api/login')
  await expect(inspector.getByRole('region', { name: 'request payload' })).toContainText('[REDACTED]')
  await expect(inspector.getByRole('region', { name: 'response payload' })).toContainText('[REDACTED]')
  for (const secret of SECRETS) await expect(map.locator('body')).not.toContainText(secret)
  expect(dialogs).toEqual([])
})

test('markup typed into a real note is shown as text in the inspector (I11)', async ({ context, request }) => {
  const { demo, dialogs } = await start(context, request)
  // Unique per run, so the clean-up below removes exactly this note.
  const note = `${MARKUP} ${Date.now()}`

  await demo.getByRole('textbox', { name: 'Note text' }).fill(note)
  await demo.getByRole('button', { name: 'Add', exact: true }).click()
  await expect(demo.getByText(note)).toBeVisible()
  await bothSides(request, 'POST', '/api/notes')

  const { inspector } = await inspect(context, 'POST /api/notes')
  await expect(inspector.getByRole('region', { name: 'request payload' })).toContainText(MARKUP)
  await expect(inspector.getByRole('region', { name: 'response payload' })).toContainText(MARKUP)
  await expect(inspector.locator('img')).toHaveCount(0)
  expect(dialogs).toEqual([])

  await demo.getByRole('button', { name: `Delete "${note}"` }).click()
  await expect(demo.getByText(note)).toHaveCount(0)
})
