// Core
import { expect, test, type Page } from '@playwright/test'

const nodeLabels = ['Browser / Client', 'DNS / CDN / WAF', 'Cloud Load Balancer', 'Envoy Gateway', 'Next.js Web',
  'NestJS API BFF', 'Projects Service', 'Tasks Service', 'Comments Service', 'Files Service', 'Search Service',
  'Notification Worker', 'Realtime Gateway', 'Redis', 'MinIO / S3', 'PostgreSQL', 'RabbitMQ', 'OpenSearch', 'Keycloak']
const nodeIds = ['browser', 'dns', 'load-balancer', 'envoy', 'web', 'bff', 'projects', 'tasks', 'comments', 'files',
  'search', 'notifications', 'realtime', 'redis', 'storage', 'postgres', 'rabbitmq', 'opensearch', 'keycloak']

async function focusNode(page: Page, id: string) {
  await page.getByRole('button', { name: 'Settings', exact: true }).click()
  await page.getByRole('tab', { name: 'Map', exact: true }).click()
  await page.getByRole('combobox', { name: 'Focus a node', exact: true }).selectOption(id)
}

test('TaskHub has all nodes, local logos, opaque dependencies and isolated reset under CSP', async ({ page }, testInfo) => {
  const errors: string[] = []
  const apiCalls: string[] = []
  const logos = new Set<string>()
  page.on('pageerror', (error) => errors.push(error.message))
  page.on('console', (message) => { if (message.type() === 'error') errors.push(message.text()) })
  page.on('request', (request) => { if (/^\/(api|v1)\//.test(new URL(request.url()).pathname)) apiCalls.push(request.url()) })
  page.on('response', (response) => {
    const match = /\/assets\/(chrome|envoy|nextjs|nestjs|fastapi|go|python|nodejs|rabbitmq|kubernetes|redis|postgresql|opensearch|keycloak|s3|network|loadBalancer)-/.exec(response.url())
    if (response.ok() && match) logos.add(match[1]!)
  })
  await page.route('**/?example=taskhub', async (route) => {
    const response = await route.fetch()
    await route.fulfill({ response, headers: { ...response.headers(), 'Content-Security-Policy': "default-src 'self'; connect-src 'self'" } })
  })
  await page.goto('/?example=taskhub')
  await expect(page.getByRole('banner')).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Console', exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Settings', exact: true })).toBeVisible()
  expect((await page.locator('canvas').boundingBox())!.y).toBe(0)
  const summary = page.getByRole('region', { name: 'TaskHub topology as text' })
  for (const label of nodeLabels) await expect(summary).toContainText(label)
  await expect.poll(() => logos.size).toBe(17)
  const notices = await page.request.get('/third-party-icons.txt')
  expect(notices.ok()).toBe(true)
  const licenses = await notices.text()
  for (const source of ['Devicon', 'Keycloak', 'OpenSearch', 'Lucide']) expect(licenses).toContain(source)
  expect(licenses).toContain('Redistribution and use in source and binary forms')
  await page.screenshot({ path: testInfo.outputPath('taskhub-overview.png') })
  for (const [index, id] of nodeIds.entries()) {
    await focusNode(page, id)
    const details = page.getByRole('complementary', { name: 'Topology details' })
    await expect(details.getByRole('heading', { name: nodeLabels[index], exact: true })).toBeVisible()
    await expect(details.getByRole('img')).toBeVisible()
  }
  await focusNode(page, 'postgres')
  await page.getByRole('button', { name: 'Run scenario', exact: true }).click()
  const exchange = page.getByRole('region', { name: 'External service exchange' })
  await expect(exchange.getByRole('status')).toHaveText('Waiting for response…', { timeout: 10_000 })
  await expect(exchange).toContainText('Internal processing is unknown')
  await page.screenshot({ path: testInfo.outputPath('taskhub-external-wait.png') })
  await expect(exchange.getByRole('status')).toHaveText('Response received', { timeout: 2_000 })
  await expect(exchange).toContainText('rows')
  await page.getByRole('button', { name: 'Reset demo', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Run scenario', exact: true })).toBeEnabled()
  await expect(summary).not.toContainText('Waiting for response.')
  const packets = await page.locator('canvas').getAttribute('data-simulated-packets')
  await page.waitForTimeout(1100)
  expect(await page.locator('canvas').getAttribute('data-simulated-packets')).toBe(packets)
  await page.getByRole('button', { name: 'Open demo app', exact: true }).click()
  await expect(page.getByRole('list', { name: 'Demo tasks' }).getByRole('listitem')).toHaveCount(1)
  await page.getByRole('complementary', { name: 'TaskHub demo app' }).evaluate(async (element) => {
    await Promise.all(element.getAnimations().map((animation) => animation.finished))
  })
  await page.screenshot({ path: testInfo.outputPath('taskhub-app.png') })
  await page.getByRole('button', { name: 'Close demo panel' }).press('Escape')
  await expect(page.getByRole('button', { name: 'Open demo app', exact: true })).toBeFocused()
  await page.getByRole('button', { name: 'Fit map', exact: true }).click()
  await page.locator('canvas').focus()
  await page.locator('canvas').press('ArrowRight')
  await expect(page.getByRole('complementary', { name: 'Topology details' })).toBeVisible()
  await page.locator('canvas').press('Escape')
  await expect(page.getByRole('complementary', { name: 'Topology details' })).toHaveCount(0)
  expect(errors).toEqual([])
  expect(apiCalls).toEqual([])
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
})

test('TaskHub app completes task, comment, direct upload, search, sign-in and page-load flows', async ({ page }) => {
  test.setTimeout(120_000)
  const apiCalls: string[] = []
  page.on('request', (request) => { if (/^\/(api|v1)\//.test(new URL(request.url()).pathname)) apiCalls.push(request.url()) })
  await page.goto('/?example=taskhub')
  await page.getByRole('button', { name: 'Open demo app', exact: true }).click()
  await page.getByLabel('Task title', { exact: true }).fill('TaskHub browser contract')
  await page.getByRole('button', { name: 'Create task', exact: true }).click()
  const run = page.getByRole('button', { name: 'Run scenario', exact: true })
  await expect(run).toBeEnabled({ timeout: 25_000 })
  await expect(page.getByRole('list', { name: 'Demo tasks' })).toContainText('TaskHub browser contract')
  await expect(page.getByRole('list', { name: 'Demo tasks' })).not.toContainText('Index pending')
  await page.getByLabel('Comment', { exact: true }).fill('<b>literal demo comment</b>')
  await page.getByRole('button', { name: 'Add comment', exact: true }).click()
  await expect(run).toBeEnabled({ timeout: 20_000 })
  const comments = page.getByRole('list', { name: 'Task comments' })
  await expect(comments).toContainText('<b>literal demo comment</b>')
  await expect(comments.locator('b')).toHaveCount(0)
  await page.getByRole('button', { name: 'Attach sample file', exact: true }).click()
  await expect(run).toBeEnabled({ timeout: 25_000 })
  await expect(page.getByRole('list', { name: 'Task attachments' })).toContainText('ready')
  await page.getByRole('button', { name: 'Search', exact: true }).click()
  await page.getByLabel('Search task titles').fill('browser contract')
  await page.getByRole('button', { name: 'Search tasks', exact: true }).click()
  await expect(run).toBeEnabled({ timeout: 15_000 })
  await expect(page.getByRole('list', { name: 'Search results' })).toContainText('TaskHub browser contract')
  await page.getByRole('button', { name: /^Updates/ }).click()
  await expect(page.getByRole('list', { name: 'Notifications' }).getByRole('listitem')).toHaveCount(2)
  await expect(page.getByRole('list', { name: 'Notifications' })).toContainText('Delivered over WebSocket')
  await page.getByRole('button', { name: 'Sign in', exact: true }).click()
  await expect(run).toBeEnabled({ timeout: 15_000 })
  await expect(page.getByRole('button', { name: 'Signed in', exact: true })).toBeDisabled()
  await page.getByRole('button', { name: 'Close demo panel' }).click()
  await page.getByRole('combobox', { name: 'Scenario', exact: true }).selectOption('open')
  await run.click()
  await expect(run).toBeEnabled({ timeout: 15_000 })
  // The ordinary console: one action per scenario, each expanding into every message across the stack.
  await page.getByRole('button', { name: 'Console', exact: true }).click()
  const actions = page.getByRole('list', { name: 'Actions', exact: true })
  for (const title of ['Create task', 'Add comment', 'Attach sample file', 'Search tasks', 'Sign in', 'Open application']) {
    await expect(actions.getByRole('button').filter({ hasText: title })).toHaveCount(1)
  }
  await actions.getByRole('button').filter({ hasText: 'Open application' }).click()
  const steps = page.getByRole('list', { name: 'Steps of Open application' })
  await expect(steps).toContainText('Next.js Web')
  await expect(steps).toContainText('Realtime Gateway')
  await steps.getByRole('button', { name: 'Open in inspector' }).first().click()
  const waterfall = page.getByRole('region', { name: 'Request waterfall' })
  await expect(waterfall.getByRole('button', { name: /^Inspect span Next\.js Web:/ }).first()).toBeVisible()
  await page.getByRole('button', { name: 'Back to logs' }).click()
  await page.getByRole('button', { name: 'Lines', exact: true }).click()
  const lines = page.getByRole('list', { name: 'Log entries' })
  for (const service of ['Browser / Client', 'Envoy Gateway', 'Next.js Web', 'NestJS API BFF', 'Projects Service', 'Tasks Service',
    'Comments Service', 'Files Service', 'Search Service', 'Notification Worker', 'Realtime Gateway']) {
    await expect(lines.getByText(service, { exact: true }).first()).toBeVisible()
  }
  await page.getByText('More filters').click()
  await page.getByRole('combobox', { name: 'Node', exact: true }).selectOption('load-balancer')
  await expect(lines.getByRole('button').first()).toContainText('DNS / CDN / WAF')
  expect(apiCalls).toEqual([])
  await page.reload()
  await page.getByRole('button', { name: 'Open demo app', exact: true }).click()
  await expect(page.getByRole('list', { name: 'Demo tasks' }).getByRole('listitem')).toHaveCount(1)
})


test('TaskHub retains the canvas, upper controls and all three console docks', async ({ page }, testInfo) => {
  await page.goto('/?example=taskhub')
  const canvas = page.locator('canvas')
  const camera = () => canvas.evaluate((element: HTMLCanvasElement) => ({
    width: element.width, height: element.height,
    transform: Array.from(element.getContext('2d')!.getTransform().toFloat64Array()),
    rect: element.getBoundingClientRect().toJSON(),
  }))
  for (const label of ['Console', 'Settings', 'Open demo app', 'Run scenario', 'Reset demo']) {
    const control = page.getByRole('button', { name: label, exact: true })
    const box = await control.boundingBox()
    expect(box!.y).toBe(16)
    expect(box!.height).toBe(44)
    const reachable = await control.evaluate((element) => {
      const box = element.getBoundingClientRect()
      return element.contains(document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2))
    })
    expect(reachable).toBe(true)
  }
  for (const dock of ['left', 'right', 'bottom']) {
    await page.getByRole('button', { name: 'Settings', exact: true }).click()
    await page.getByRole('tab', { name: 'Console', exact: true }).click()
    await page.getByRole('combobox', { name: 'Dock position' }).selectOption(dock)
    await page.getByRole('button', { name: 'Close settings' }).click()
    const before = await camera()
    await page.getByRole('button', { name: 'Console', exact: true }).click()
    const panel = page.getByRole('complementary', { name: 'Logs and request inspector' })
    await expect(panel).toHaveClass(new RegExp(`investigation-panel--${dock}`))
    await expect(panel).toContainText('No activity yet')
    expect(await camera()).toEqual(before)
    await page.getByRole('button', { name: 'Close logs panel' }).press('Escape')
    await expect(page.getByRole('button', { name: 'Console', exact: true })).toBeFocused()
  }
  await focusNode(page, 'browser')
  await page.getByRole('button', { name: 'Close topology details' }).click()
  await page.screenshot({ path: testInfo.outputPath('taskhub-detailed-card.png') })
  await page.reload()
  await page.getByRole('button', { name: 'Console', exact: true }).click()
  await expect(page.getByRole('complementary', { name: 'Logs and request inspector' })).toHaveClass(/investigation-panel--bottom/)
})
