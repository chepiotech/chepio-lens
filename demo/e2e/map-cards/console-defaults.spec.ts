// Core
import { expect, test } from '@playwright/test'
// Types
import type { ActivityView } from '../../../ui/src/api/generated/ActivityView'
import type { LogEntryView } from '../../../ui/src/api/generated/LogEntryView'

const activity: ActivityView = {
  id: 'action:0123456789abcdef', cursor: '1792930000000000000.1', origin: 'action', title: 'click Save',
  time: '1792930000000000000', service: 'test-web', duration_ms: null, layers: ['frontend'], services: ['test-web'],
  nodes: [], traces: [], traces_unlisted: 0, lines: 1, error: false, status_code: null,
}
const entry: LogEntryView = {
  id: '1792930000000000000.1', time: '1792930000000000000', trace_id: null, span_id: null,
  duration_ms: null, layer: 'frontend', kind: 'log', service: 'test-web', nodes: [], text: 'Saved draft',
  status_code: null, error: false, level: 'info',
  record: { body: 'Saved draft', truncated: false, attributes: [{ key: 'example', kind: 'string', values: ['fixture'] }] },
}

test('console always opens with filters and details collapsed while preserving filter values', async ({ page }) => {
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
  await page.route('**/api/graph', (route) => route.fulfill({ json: { nodes: [], edges: [], generated_at: '1' } }))
  await page.route('**/api/activities?*', (route) => route.fulfill({ json: { activities: [activity], next_before: null } }))
  await page.route('**/api/activities/*', (route) => route.fulfill({ json: { activity, steps: [], truncated_steps: 0 } }))
  await page.route('**/api/logs?*', (route) => route.fulfill({ json: { entries: [entry], next_before: null } }))
  await page.goto('/')
  const consoleButton = page.getByRole('button', { name: 'Console', exact: true })
  const panel = page.getByRole('complementary', { name: 'Logs and request inspector' })
  const filters = panel.locator('details').filter({ has: page.locator('summary', { hasText: 'More filters' }) })
  const row = page.getByRole('list', { name: 'Actions', exact: true }).getByRole('button')
  await consoleButton.click()
  await expect(filters).not.toHaveAttribute('open')
  await expect(row).toHaveAttribute('aria-expanded', 'false')
  const originalViewport = page.viewportSize()!
  await page.setViewportSize({ width: originalViewport.width > 760 ? 390 : 1440, height: 844 })
  await expect(filters).not.toHaveAttribute('open')
  await page.setViewportSize(originalViewport)
  await filters.locator('summary').click()
  await page.getByRole('combobox', { name: 'Origin', exact: true }).selectOption('action')
  await row.click()
  await expect(row).toHaveAttribute('aria-expanded', 'true')
  await page.getByRole('button', { name: 'Close logs panel' }).click()
  await consoleButton.click()
  await expect(filters).not.toHaveAttribute('open')
  await expect(row).toHaveAttribute('aria-expanded', 'false')
  await filters.locator('summary').click()
  await expect(page.getByRole('combobox', { name: 'Origin', exact: true })).toHaveValue('action')
  await page.getByRole('button', { name: 'Lines', exact: true }).click()
  await page.getByRole('list', { name: 'Log entries' }).getByRole('button').click()
  const attributes = panel.locator('details').filter({ has: page.locator('summary', { hasText: 'Log attributes' }) })
  await expect(attributes).not.toHaveAttribute('open')
  await attributes.locator('summary').click()
  await expect(attributes).toHaveAttribute('open')
  await page.getByRole('button', { name: 'Close logs panel' }).click()
  await consoleButton.click()
  await expect(page.getByRole('region', { name: 'Request inspector' })).toHaveCount(0)
  await expect(page.getByRole('list', { name: 'Log entries' })).toBeVisible()
  await expect(filters).not.toHaveAttribute('open')
  await page.getByRole('list', { name: 'Log entries' }).getByRole('button').click()
  await expect(attributes).not.toHaveAttribute('open')
})
