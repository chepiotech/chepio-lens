// Core
import { expect, test, type APIRequestContext } from '@playwright/test'
// Utils
import { openLogLines, showLogLines } from './support/collector'

const lens = () => test.info().project.use.baseURL ?? 'http://localhost:4320'
const otlp = () => test.info().config.metadata.otlpUrl ?? 'http://localhost:4318'

async function sendExample(request: APIRequestContext, id: number, fail = false) {
  const start = 1_790_000_000_000_000_000n + BigInt(id) * 100_000_000n
  const traceId = id.toString(16).padStart(32, '0')
  const value = (key: string, stringValue: string) => ({ key, value: { stringValue } })
  const route = fail ? '/api/fail' : '/api/login'
  const span = (spanId: string, parentSpanId: string | undefined, kind: number, offset: number, duration: number, attributes: ReturnType<typeof value>[]) => ({
    traceId, spanId, parentSpanId, kind, name: kind === 3 && spanId.endsWith('3') ? 'SELECT example' : `POST ${route}`,
    startTimeUnixNano: (start + BigInt(offset) * 1_000_000n).toString(),
    endTimeUnixNano: (start + BigInt(offset + duration) * 1_000_000n).toString(),
    attributes, status: { code: fail && kind === 2 ? 2 : 1 },
    events: kind === 2 && fail ? [{ name: 'exception', timeUnixNano: (start + 1_000_000n).toString(), attributes: [value('exception.message', 'Example failure <b>literal</b>')] }] : [],
  })
  const http = [value('http.request.method', 'POST'), value('url.full', `http://example.test${route}`),
    value('http.response.status_code', fail ? '500' : '200')]
  const payload = [value('http.request.header.content-type', 'application/json'), value('http.request.header.authorization', 'Bearer fixture-secret'),
    value('lens.http.request.body', fail ? '{broken' : '{"username":"demo","password":"fixture-password","note":"<img src=x onerror=alert(1)>"}'),
    value('http.response.header.content-type', 'application/json'), value('lens.http.response.body', '{"ok":true}')]
  const resource = (name: string, kind: string, spans: unknown[]) => ({ resource: { attributes: [value('service.name', name), value('lens.node.kind', kind)] }, scopeSpans: [{ spans }] })
  const response = await request.post(`${otlp()}/v1/traces`, { data: { resourceSpans: [
    resource('inspector-web', 'frontend', [span('0000000000000001', undefined, 3, 0, 20, http)]),
    resource('inspector-api', 'service', [
      span('0000000000000002', '0000000000000001', 2, -1, 15, [...http, ...payload, value('http.route', route)]),
      span('0000000000000003', '0000000000000002', 3, 2, 2, [value('db.system.name', 'postgresql'), value('db.query.text', "SELECT '<b>literal</b>'"), value('server.address', 'example-db')]),
    ]),
  ] } })
  expect(response.status()).toBe(200)
  return traceId
}

test.beforeEach(async ({ request }) => {
  expect((await request.post(`${lens()}/api/reset`)).status()).toBe(204)
  await sendExample(request, 101)
  await sendExample(request, 102, true)
})

test('logs filter by layer, node, edge, status and text; edge selection opens its calls', async ({ page }) => {
  await page.goto(lens())
  await expect(page.getByRole('region', { name: 'Map as text' })).toContainText('inspector-web')
  const canvas = await page.locator('canvas').boundingBox()
  if (!canvas) throw new Error('Map canvas is missing')
  await page.mouse.click(canvas.x + canvas.width / 2 - 168, canvas.y + canvas.height / 2)
  await expect(page.getByRole('combobox', { name: 'Edge', exact: true })).toHaveValue('svc:inspector-web->svc:inspector-api')
  await showLogLines(page)
  const entries = page.getByRole('list', { name: 'Log entries' }).getByRole('button')
  await expect(entries).toHaveCount(4)
  await page.getByText('Edge statistics and routes', { exact: true }).click()
  await expect(page.getByRole('region', { name: 'Calls by route' })).toContainText('POST /api/login')
  await page.getByText('Edge statistics and routes', { exact: true }).click()
  await page.getByRole('button', { name: 'frontend', exact: true }).click()
  await page.getByRole('button', { name: 'database', exact: true }).click()
  await expect(entries).toHaveCount(2)
  await page.getByLabel('Search logs').fill('/api/fail')
  await expect(entries).toHaveCount(1)
  await expect(entries).toContainText('backend')
  await page.getByRole('combobox', { name: 'Status', exact: true }).selectOption('ok')
  await expect(entries).toHaveCount(0)
  await page.getByRole('button', { name: 'Clear filters' }).click()
  await expect(entries).toHaveCount(6)
  await page.getByRole('combobox', { name: 'Node', exact: true }).selectOption('svc:inspector-api')
  await expect(entries).toHaveCount(4)
})

test('inspector shows a waterfall and redacted payloads as text, with SQL, errors and clock skew', async ({ page }) => {
  let dialogs = 0
  page.on('dialog', async (dialog) => { dialogs += 1; await dialog.dismiss() })
  await page.goto(lens())
  await openLogLines(page)
  const entries = page.getByRole('list', { name: 'Log entries' }).getByRole('button')
  await entries.filter({ hasText: 'backend' }).filter({ hasText: '/api/login' }).click()
  const inspector = page.getByRole('region', { name: 'Request inspector' })
  await expect(inspector.getByRole('region', { name: 'Request waterfall' }).getByRole('button')).toHaveCount(3)
  await expect(inspector).toContainText('Starts before its parent')
  await expect(inspector.getByRole('region', { name: 'request payload' })).toContainText('[REDACTED]')
  await expect(inspector).not.toContainText('fixture-password')
  await expect(inspector).not.toContainText('fixture-secret')
  await expect(inspector).toContainText('<img src=x onerror=alert(1)>')
  await expect(inspector.locator('img')).toHaveCount(0)
  expect(dialogs).toBe(0)
  await inspector.getByRole('button', { name: 'Inspect span inspector-api: SELECT example' }).click()
  await expect(inspector.getByRole('region', { name: 'SQL query' })).toContainText("SELECT '<b>literal</b>'")
  await page.getByRole('button', { name: 'Back to logs' }).click()
  await entries.filter({ hasText: 'backend' }).filter({ hasText: '/api/fail' }).click()
  await expect(inspector).toContainText('Not valid JSON — keys could not be masked.')
  await expect(inspector.getByRole('region', { name: 'Span events' })).toContainText('Example failure <b>literal</b>')
  await expect(inspector.getByRole('region', { name: 'Span error' })).toBeVisible()
})

test('live tail pauses for reading, resumes fresh activity and remembers docking and resizing', async ({ page, request }) => {
  await page.addInitScript(() => {
    const NativeEventSource = window.EventSource
    window.EventSource = class extends NativeEventSource {
      constructor(url: string | URL, options?: EventSourceInit) {
        super(url, options)
        ;(window as unknown as { source: EventSource }).source = this
      }
    }
  })
  let logLoads = 0
  page.on('request', (request) => { if (new URL(request.url()).pathname === '/api/logs') logLoads += 1 })
  await page.goto(lens())
  await openLogLines(page)
  const entries = page.getByRole('list', { name: 'Log entries' }).getByRole('button')
  await expect(entries).toHaveCount(6)
  await page.getByRole('button', { name: 'Pause live' }).click()
  await sendExample(request, 103)
  await expect(page.getByRole('button', { name: 'Resume live · new activity' })).toBeVisible()
  await expect(entries).toHaveCount(6)
  const previousLoads = logLoads
  const graphReload = page.waitForResponse('**/api/graph')
  await page.evaluate(() => (window as unknown as { source: EventSource }).source.dispatchEvent(new Event('open')))
  await (await graphReload).finished()
  expect(logLoads, 'reconnecting must preserve the paused reading window').toBe(previousLoads)
  await expect(entries).toHaveCount(6)
  await page.getByRole('button', { name: 'Resume live' }).click()
  await expect(entries).toHaveCount(9)
  await page.getByRole('button', { name: 'Close logs panel' }).click()
  await page.getByRole('button', { name: 'Settings', exact: true }).click()
  await page.getByRole('tab', { name: 'Console', exact: true }).click()
  await page.getByRole('combobox', { name: 'Dock position' }).selectOption('bottom')
  await page.getByRole('button', { name: 'Close settings' }).click()
  await page.getByRole('button', { name: 'Console', exact: true }).click()
  const resize = page.getByRole('separator', { name: 'Resize logs panel' })
  await resize.focus()
  await page.keyboard.press('ArrowUp')
  await expect(resize).toHaveAttribute('aria-valuenow', '384')
  await page.reload()
  await openLogLines(page)
  await expect(page.locator('.investigation-panel')).toHaveClass(/investigation-panel--bottom/)
  await expect(page.getByRole('button', { name: /Dock/ })).toHaveCount(0)
  await expect(resize).toHaveAttribute('aria-valuenow', '384')
  await page.getByRole('button', { name: 'Settings', exact: true }).click()
  await page.getByRole('button', { name: 'Reset', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Reset', exact: true })).toBeEnabled()
  await page.getByRole('button', { name: 'Close settings' }).click()
  await expect(entries).toHaveCount(0)
})

test('older pages stay bounded and a late search response cannot restore old results', async ({ page }) => {
  const all = Array.from({ length: 2_500 }, (_, id) => ({
    id: `1790000000000000000.${id}`, time: '1790000000000000000', trace_id: '1'.repeat(32), span_id: '1'.repeat(16),
    duration_ms: 0.06, layer: 'frontend', kind: 'request', service: 'example', nodes: ['svc:example'],
    text: `GET /item-${id}`, status_code: 200, error: false,
  })).reverse()
  let release: () => void = () => {}
  const gate = new Promise<void>((resolve) => { release = resolve })
  let delayed = false
  await page.route('**/api/logs?*', async (route) => {
    const query = new URL(route.request().url()).searchParams
    const before = query.get('before')
    const matches = all.filter((entry) => (!before || BigInt(entry.id.split('.')[1]!) < BigInt(before.split('.')[1]!)) && entry.text.includes(query.get('q') ?? ''))
    if (query.get('q') === 'delayed') { delayed = true; await gate }
    const entries = matches.slice(0, 500)
    await route.fulfill({ json: { entries, next_before: matches.length > 500 ? entries.at(-1)!.id : null } })
  })
  await page.goto(lens())
  await openLogLines(page)
  const entries = page.getByRole('list', { name: 'Log entries' }).getByRole('button')
  await expect(entries).toHaveCount(500)
  await page.getByRole('button', { name: 'Pause live' }).click()
  const logWindow = page.getByLabel('Log lines', { exact: true })
  // Scrolling to a button can itself load a page; drive the supported scroll path once per page instead.
  for (const [count, first] of [[1_000, 1_500], [1_500, 1_000], [2_000, 500], [2_000, 0]] as const) {
    await logWindow.evaluate((element) => { element.scrollTop = 0 })
    await expect(entries.first()).toContainText(`GET /item-${first}`)
    await expect(entries).toHaveCount(count)
    await expect(logWindow).toHaveAttribute('aria-busy', 'false')
  }
  await expect(page.getByRole('button', { name: 'Load earlier lines' })).toHaveCount(0)
  await expect(entries.first()).toContainText('GET /item-0')
  await expect(entries.last()).toContainText('GET /item-1999')
  await page.getByLabel('Search logs').fill('delayed')
  await expect.poll(() => delayed).toBe(true)
  await page.getByLabel('Search logs').fill('item-2499')
  await expect(entries).toHaveCount(1)
  release()
  await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))))
  await expect(entries).toHaveCount(1)
  await expect(entries).toContainText('item-2499')
})

test('failed log loads can be retried and an evicted request is explained', async ({ page }) => {
  let unavailable = true
  await page.route('**/api/logs?*', async (route) => {
    if (unavailable) await route.fulfill({ status: 503, body: '' })
    else await route.continue()
  })
  await page.goto(lens())
  await openLogLines(page)
  await expect(page.getByRole('alert')).toContainText('Could not load logs')
  unavailable = false
  await page.getByRole('button', { name: 'Retry logs' }).click()
  const entries = page.getByRole('list', { name: 'Log entries' }).getByRole('button')
  await expect(entries).toHaveCount(6)
  await page.route('**/api/requests/*', (route) => route.fulfill({ status: 404, body: '' }))
  await entries.first().click()
  await expect(page.getByRole('alert')).toContainText('This request is no longer available')
  await expect(page.getByRole('button', { name: 'Back to logs' })).toBeVisible()
})
