// Core
import { expect, test } from '@playwright/test'

test('technology stacks, microfrontends and Redis work under the collector CSP', async ({ page }, testInfo) => {
  const errors: string[] = []
  const apiCalls: string[] = []
  const loadedLogos = new Set<string>()
  page.on('pageerror', (error) => errors.push(error.message))
  page.on('console', (message) => { if (message.type() === 'error') errors.push(message.text()) })
  page.on('request', (request) => { if (new URL(request.url()).pathname.startsWith('/api/')) apiCalls.push(request.url()) })
  page.on('response', (response) => {
    if (response.ok() && /\/assets\/(react|vue|angular|rust|redis|postgresql)-[^/]+\.svg$/.test(response.url())) loadedLogos.add(response.url())
  })
  await page.route('**/?example=architecture', async (route) => {
    const response = await route.fetch()
    await route.fulfill({ response, headers: { ...response.headers(), 'Content-Security-Policy': "default-src 'self'; connect-src 'self'" } })
  })
  await page.goto('/?example=architecture')
  await expect(page.getByRole('button', { name: 'Settings', exact: true })).toBeVisible()
  await expect(page.getByRole('banner')).toHaveCount(0)
  const summary = page.getByRole('region', { name: 'Map as text' })
  await expect(summary).toContainText('Rust, axum, SQLx')
  await expect(summary).toContainText('Notes (React)')
  await expect(summary).toContainText('Workspace (Vue)')
  await expect(summary).toContainText('Redis (database) — Cache')
  await expect.poll(() => loadedLogos.size).toBe(6)
  const canvas = page.locator('canvas')
  await canvas.focus()
  await canvas.press('ArrowRight')
  await expect(page.getByRole('complementary', { name: 'Selection details' })).toContainText('SQLx')
  await canvas.press('ArrowRight')
  await expect(page.getByRole('complementary', { name: 'Selection details' })).toContainText('notes:list')
  await canvas.press('Escape')
  await expect(page.getByRole('complementary', { name: 'Selection details' })).toHaveCount(0)
  await page.getByRole('button', { name: 'Zoom in', exact: true }).click()
  await page.getByRole('button', { name: 'Fit map', exact: true }).click()
  if (testInfo.project.name === 'mobile') {
    await page.getByRole('button', { name: 'Settings', exact: true }).click()
    await page.getByRole('tab', { name: 'Map', exact: true }).click()
    await page.getByRole('combobox', { name: 'Focus a node' }).selectOption('example:web')
    const bounds = await canvas.boundingBox()
    // Click near the bottom of the expanded frontend: beyond the former fixed-height node hit area.
    await page.mouse.click(bounds!.x + bounds!.width / 2, bounds!.y + bounds!.height / 2 + 175)
    await expect(page.getByRole('complementary', { name: 'Selection details' })).toContainText('Microfrontends')
    await page.getByRole('button', { name: 'Close details' }).click()
  }
  expect(errors).toEqual([])
  expect(apiCalls).toEqual([])
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
  await page.screenshot({ path: testInfo.outputPath('node-cards.png') })
})
