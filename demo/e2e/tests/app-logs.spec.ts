// Core
import { expect, test, type APIRequestContext } from '@playwright/test'

const lens = 'http://localhost:4320'
const demo = 'http://localhost:5173'
async function logs(request: APIRequestContext, query: string) {
  const response = await request.get(`${lens}/api/logs?${query}`)
  expect(response.status()).toBe(200)
  return (await response.json()).entries as { trace_id: string | null; span_id: string | null; text: string; record: { body: string } }[]
}

test('React click links to its request; an async continuation does not inherit a guessed action', async ({ page, request, context }) => {
  await page.goto(demo)
  await expect(page.getByRole('button', { name: 'Log in', exact: true })).toBeEnabled()
  await request.post(`${lens}/api/reset`)
  await page.getByRole('button', { name: 'Log in', exact: true }).click()
  await expect(page.getByLabel('Last response')).toContainText('200')
  await expect.poll(async () => (await logs(request, 'kind=action&q=click%20Log%20in')).length).toBe(1)
  const action = (await logs(request, 'kind=action&q=click%20Log%20in'))[0]!
  expect(action.trace_id).toMatch(/^[0-9a-f]{32}$/)
  // Logs and spans use separate batches; either pipeline can arrive first.
  await expect.poll(async () => {
    const response = await request.get(`${lens}/api/requests/${action.trace_id}`)
    if (response.status() === 404) return false
    expect(response.status()).toBe(200)
    const detail = await response.json()
    return detail.spans.some((span: { span_id: string }) => span.span_id === action.span_id)
  }).toBe(true)
  const map = await context.newPage()
  await map.goto(lens)
  await map.getByRole('button', { name: 'Logs', exact: true }).click()
  await map.getByRole('combobox', { name: 'Kind', exact: true }).selectOption('action')
  await map.getByRole('list', { name: 'Log entries' }).getByRole('button').filter({ hasText: 'click Log in' }).click()
  await expect(map.getByRole('region', { name: 'Log record' })).toContainText('User action')
  await expect(map.getByRole('region', { name: 'Request waterfall' })).toBeVisible()

  await page.evaluate(() => {
    const button = document.createElement('button'); button.textContent = 'Async action probe'; document.body.append(button)
    button.addEventListener('click', async () => { await Promise.resolve(); await fetch('/api/health') })
  })
  await page.getByRole('button', { name: 'Async action probe' }).click()
  await expect.poll(async () => (await logs(request, 'kind=action&q=Async%20action%20probe')).length).toBe(1)
  expect((await logs(request, 'kind=action&q=Async%20action%20probe'))[0]!.trace_id).toBeNull()
})

test('console logs keep levels, mask structured arguments and render malicious text literally', async ({ page, request, context }) => {
  await page.goto(demo)
  await expect(page.getByRole('button', { name: 'Log in', exact: true })).toBeEnabled()
  await request.post(`${lens}/api/reset`)
  await page.evaluate(() => {
    console.warn('e2e-application-message', { password: 'fake-console-password', nested: { token: 'fake-console-token' }, note: '<img src=x onerror=alert(1)>' })
    console.info('e2e-info-message')
  })
  await expect.poll(async () => (await logs(request, 'kind=log&level=warn&q=e2e-application-message')).length).toBe(1)
  const entry = (await logs(request, 'kind=log&level=warn&q=e2e-application-message'))[0]!
  expect(entry.record.body).toContain('[REDACTED]')
  expect(entry.record.body).not.toContain('fake-console-')
  const map = await context.newPage()
  let dialogs = 0; map.on('dialog', async dialog => { dialogs++; await dialog.dismiss() })
  await map.goto(lens)
  await map.getByRole('button', { name: 'Logs', exact: true }).click()
  await map.getByRole('combobox', { name: 'Kind', exact: true }).selectOption('log')
  await map.getByRole('combobox', { name: 'Level', exact: true }).selectOption('warn')
  const entries = map.getByRole('list', { name: 'Log entries' }).getByRole('button')
  await expect(entries).toHaveCount(1); await entries.click()
  const record = map.getByRole('region', { name: 'Log record' })
  await expect(record).toContainText('<img src=x onerror=alert(1)>')
  await expect(record.locator('img')).toHaveCount(0)
  await expect(map.getByRole('region', { name: 'Request inspector' })).toContainText('This log has no request context.')
  expect(dialogs).toBe(0)
})

test('standalone backend logs arrive live and remain inspectable without a request', async ({ page, request }) => {
  await request.post(`${lens}/api/reset`)
  await page.goto(lens)
  await page.getByRole('button', { name: 'Logs', exact: true }).click()
  const result = await request.post('http://localhost:4318/v1/logs', { data: {
    resourceLogs: [{ resource: { attributes: [{ key: 'service.name', value: { stringValue: 'log-worker' } }] }, scopeLogs: [{ logRecords: [{
      timeUnixNano: (BigInt(Date.now()) * 1_000_000n).toString(), severityNumber: 17, body: { stringValue: 'worker-job-failed' },
      attributes: [{ key: 'authorization', value: { stringValue: 'fake-worker-secret' } }, { key: 'lens.log.truncated', value: { boolValue: true } }],
    }] }] }],
  } })
  expect(result.status()).toBe(200)
  const row = page.getByRole('list', { name: 'Log entries' }).getByRole('button').filter({ hasText: 'worker-job-failed' })
  await expect(row).toBeVisible(); await row.click()
  await expect(page.getByRole('region', { name: 'Log record' })).toContainText('[REDACTED]')
  await expect(page.getByRole('region', { name: 'Log record' })).toContainText('Log truncated')
  await expect(page.getByRole('region', { name: 'Request inspector' })).toContainText('This log has no request context.')
  await page.getByRole('button', { name: 'Reset', exact: true }).click()
  await expect(page.getByRole('list', { name: 'Log entries' }).getByRole('button')).toHaveCount(0)
})

test('expanded filters leave a readable log window on a narrow screen', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await page.goto(lens)
  await page.getByRole('button', { name: 'Logs', exact: true }).click()
  await page.getByText('More filters', { exact: true }).click()
  await page.getByRole('combobox', { name: 'Kind', exact: true }).selectOption('log')
  await page.getByRole('combobox', { name: 'Level', exact: true }).selectOption('warn')
  const dimensions = await page.getByLabel('Log lines', { exact: true }).evaluate(element => ({
    height: element.getBoundingClientRect().height, viewport: innerWidth, pageWidth: document.documentElement.scrollWidth,
  }))
  expect(dimensions.height).toBeGreaterThanOrEqual(120)
  expect(dimensions.pageWidth).toBe(dimensions.viewport)
})
