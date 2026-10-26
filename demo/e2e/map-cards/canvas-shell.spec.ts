// Core
import { expect, test } from '@playwright/test'

test('canvas shell keeps copy out of the way and opens an accessible settings dialog', async ({ page }, testInfo) => {
  const apiCalls: string[] = []
  page.on('request', (request) => { if (new URL(request.url()).pathname.startsWith('/api/')) apiCalls.push(request.url()) })
  await page.goto('/?example=architecture')
  await expect(page.getByRole('banner')).toHaveCount(0)
  for (const text of ['Inside a request', 'A web app, its API, and two ways to reach the data.',
    'Illustrative pages, operations and timings. Select a node to explore.']) {
    await expect(page.getByText(text, { exact: true })).toHaveCount(0)
  }
  await expect(page.getByRole('dialog')).toHaveCount(0)
  const canvas = await page.locator('canvas').boundingBox()
  expect(canvas!.y).toBe(0)
  const footer = page.getByRole('contentinfo')
  await expect(footer.getByRole('link', { name: 'Developed by Chepio' })).toBeVisible()
  await expect(footer).toHaveText('')
  await page.screenshot({ path: testInfo.outputPath('canvas.png'), animations: 'disabled' })

  const consoleButton = page.getByRole('button', { name: 'Console', exact: true })
  const settingsButton = page.getByRole('button', { name: 'Settings', exact: true })
  const consoleBounds = await consoleButton.boundingBox()
  const settingsBounds = await settingsButton.boundingBox()
  expect(consoleBounds!.x).toBe(16)
  expect(settingsBounds!.x + settingsBounds!.width).toBe(page.viewportSize()!.width - 16)
  await consoleButton.click()
  await expect(consoleButton).toHaveAttribute('aria-expanded', 'true')
  await expect(page.getByRole('complementary', { name: 'Logs and request inspector' })).toContainText('No live requests in this example.')
  await page.screenshot({ path: testInfo.outputPath('console.png'), animations: 'disabled' })
  await page.getByRole('button', { name: 'Close logs panel' }).click()
  await expect(page.getByRole('complementary', { name: 'Logs and request inspector' })).toHaveCount(0)

  await settingsButton.click()
  const dialog = page.getByRole('dialog', { name: 'Settings' })
  await expect(dialog).toBeVisible()
  await expect(dialog.getByRole('link', { name: 'Live map' })).toHaveAttribute('href', '?')
  await expect(dialog).toContainText('Illustrative data. No collector connection.')
  await expect(dialog.getByRole('button', { name: 'Reset', exact: true })).toHaveCount(0)
  await expect(dialog.getByRole('button', { name: 'Close settings' })).toBeFocused()
  const bounds = await dialog.boundingBox()
  const viewport = page.viewportSize()!
  expect(Math.abs(bounds!.x + bounds!.width / 2 - viewport.width / 2)).toBeLessThan(2)
  expect(Math.abs(bounds!.y + bounds!.height / 2 - viewport.height / 2)).toBeLessThan(2)
  // Native modal focus must never reach the canvas or the footer underneath it.
  for (let index = 0; index < 8; index += 1) {
    await page.keyboard.press('Tab')
    expect(await dialog.evaluate((element) => element.contains(document.activeElement))).toBe(true)
  }
  await page.screenshot({ path: testInfo.outputPath('settings.png'), animations: 'disabled' })
  await dialog.getByRole('tab', { name: 'General', exact: true }).focus()
  await page.keyboard.press('ArrowRight')
  await expect(dialog.getByRole('tab', { name: 'Console', exact: true })).toBeFocused()
  await dialog.getByRole('combobox', { name: 'Dock position' }).selectOption('bottom')
  await page.keyboard.press('Escape')
  await expect(dialog).toHaveCount(0)
  await expect(settingsButton).toBeFocused()
  await consoleButton.click()
  await expect(page.locator('.investigation-panel')).toHaveClass(/investigation-panel--bottom/)
  await page.getByRole('button', { name: 'Close logs panel' }).click()

  await page.reload()
  await settingsButton.click()
  await dialog.getByRole('tab', { name: 'Console', exact: true }).click()
  await expect(dialog.getByRole('combobox', { name: 'Dock position' })).toHaveValue('bottom')
  await page.mouse.click(2, 2)
  await expect(dialog).toHaveCount(0)
  await expect(settingsButton).toBeFocused()
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
  expect(apiCalls).toEqual([])
})

test('live console and session reset work through settings, including errors and pending state', async ({ page }) => {
  let reset = false
  let failReset = true
  let finishReset: () => void = () => {}
  const pendingReset = new Promise<void>((resolve) => { finishReset = resolve })
  let logLoads = 0
  let activityLoads = 0
  await page.addInitScript(() => {
    class Feed extends EventTarget {
      static CLOSED = 2
      readyState = 0
      onopen: (() => void) | null = null
      constructor() {
        super()
        setTimeout(() => { if (this.readyState !== 2) { this.readyState = 1; this.onopen?.() } }, 0)
      }
      close() { this.readyState = 2 }
    }
    Object.defineProperty(window, 'EventSource', { value: Feed })
  })
  await page.route('**/api/graph', (route) => route.fulfill({ json: { nodes: reset ? [] : [
    { id: 'web', label: 'Test web', kind: 'frontend', db_system: null, address: null, port: null, namespace: null, first_seen: '1', last_seen: '1' },
  ], edges: [], generated_at: '1' } }))
  await page.route('**/api/logs?*', (route) => {
    logLoads += 1
    return route.fulfill({ json: { entries: [], next_before: null } })
  })
  await page.route('**/api/activities?*', (route) => {
    activityLoads += 1
    return route.fulfill({ json: { activities: [], next_before: null } })
  })
  await page.route('**/api/reset', async (route) => {
    if (failReset) await route.fulfill({ status: 503 })
    else { await pendingReset; reset = true; await route.fulfill({ status: 204 }) }
  })
  await page.goto('/')
  await expect(page.getByRole('region', { name: 'Map as text' })).toContainText('Test web')
  expect(logLoads).toBe(0)
  expect(activityLoads).toBe(0)
  await page.getByRole('button', { name: 'Console', exact: true }).click()
  await expect(page.getByRole('region', { name: 'Request logs' })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Actions', exact: true })).toHaveAttribute('aria-pressed', 'true')
  await expect.poll(() => activityLoads).toBe(1)
  expect(logLoads).toBe(0)
  await page.getByRole('button', { name: 'Lines', exact: true }).click()
  await expect.poll(() => logLoads).toBe(1)
  await page.getByRole('button', { name: 'Close logs panel' }).click()
  await page.getByRole('button', { name: 'Settings', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: 'Settings' })
  await expect(dialog.getByRole('status')).toHaveText('Live')
  await expect(dialog.getByRole('link', { name: 'Example map' })).toHaveAttribute('href', '?example=architecture')
  await dialog.getByRole('button', { name: 'Reset', exact: true }).click()
  await expect(dialog.getByRole('alert')).toContainText('Reset failed')
  failReset = false
  await dialog.getByRole('button', { name: 'Reset', exact: true }).click()
  await expect(dialog.getByRole('button', { name: 'Resetting…' })).toBeDisabled()
  finishReset()
  await expect(dialog.getByRole('button', { name: 'Reset', exact: true })).toBeEnabled()
  await expect(dialog.getByRole('alert')).toHaveCount(0)
  await expect(dialog).toContainText('0 nodes · 0 connections')
  await dialog.getByRole('button', { name: 'Close settings' }).click()
  await expect(page.getByRole('region', { name: 'Map as text' })).not.toContainText('Test web')
  await page.getByRole('button', { name: 'Console', exact: true }).click()
  await expect(page.getByRole('region', { name: 'Request logs' })).toBeVisible()
})

for (const dock of ['left', 'right', 'bottom'] as const) {
  test(`${dock} console overlays the page without resizing or refitting the canvas`, async ({ page }, testInfo) => {
    await page.addInitScript(() => localStorage.setItem('chepio-lens.panel', JSON.stringify({ dock: 'right', width: 340, height: 360 })))
    await page.goto('/?example=architecture')
    const settings = page.getByRole('button', { name: 'Settings', exact: true })
    await settings.click()
    await page.getByRole('tab', { name: 'Console', exact: true }).click()
    await page.getByRole('combobox', { name: 'Dock position' }).selectOption(dock)
    await page.getByRole('button', { name: 'Close settings' }).click()
    await page.getByRole('button', { name: 'Zoom in', exact: true }).click()
    const settle = () => page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))))
    await settle()
    const canvas = page.locator('canvas')
    const camera = () => canvas.evaluate((element: HTMLCanvasElement) => ({
      width: element.width, height: element.height,
      transform: Array.from(element.getContext('2d')!.getTransform().toFloat64Array()),
      rect: element.getBoundingClientRect().toJSON(),
    }))
    const before = await camera()
    await page.getByRole('button', { name: 'Console', exact: true }).click()
    const panel = page.getByRole('complementary', { name: 'Logs and request inspector' })
    await expect(panel).toBeVisible()
    await panel.evaluate(async (element) => { await Promise.all(element.getAnimations().map((animation) => animation.finished)) })
    await settle()
    expect(await camera()).toEqual(before)
    await expect(panel.getByRole('button', { name: /Dock/ })).toHaveCount(0)

    const resize = page.getByRole('separator', { name: 'Resize logs panel' })
    await resize.focus()
    await resize.press(dock === 'left' ? 'ArrowRight' : dock === 'right' ? 'ArrowLeft' : 'ArrowUp')
    await expect(resize).toHaveAttribute('aria-valuenow', dock === 'bottom' ? '384' : '364')
    if (dock === 'left') {
      const grip = await resize.boundingBox()
      const x = grip!.x + grip!.width / 2
      const y = grip!.y + grip!.height / 2
      await page.mouse.move(x, y)
      await page.mouse.down()
      await page.mouse.move(x - 16, y)
      await page.mouse.up()
      await expect(resize).toHaveAttribute('aria-valuenow', '348')
    }
    await settle()
    expect(await camera()).toEqual(before)
    // This also proves the overlay covers the footer, not only the canvas container.
    expect(await panel.evaluate((element) => {
      const box = element.getBoundingClientRect()
      return document.elementFromPoint(box.x + box.width / 2, innerHeight - 2)?.closest('.investigation-panel') === element
    })).toBe(true)
    await page.screenshot({ path: testInfo.outputPath(`console-${dock}.png`), animations: 'disabled' })
    const bounds = await panel.boundingBox()
    if (dock === 'left') expect(bounds!.x).toBe(0)
    if (dock === 'right') expect(bounds!.x + bounds!.width).toBe(page.viewportSize()!.width)
    if (dock === 'bottom') expect(bounds!.y + bounds!.height).toBe(page.viewportSize()!.height)
    await page.getByRole('button', { name: 'Close logs panel' }).click()
    await settle()
    expect(await camera()).toEqual(before)
    await settings.click()
    await expect(page.getByRole('combobox', { name: 'Dock position' })).toHaveValue(dock)
    expect(await page.evaluate(() => JSON.parse(localStorage.getItem('chepio-lens.panel')!).dock)).toBe(dock)
  })
}
