// Core
import { expect, test } from '@playwright/test'
// Types
import type { GraphView } from '../../../ui/src/api/generated/GraphView'
import type { NodeView } from '../../../ui/src/api/generated/NodeView'

test('live cards accept old snapshots and update from SDK metadata events', async ({ page }) => {
  const errors: string[] = []
  page.on('pageerror', (error) => errors.push(error.message))
  const frontend: NodeView = { id: 'web', label: 'Live web', kind: 'frontend', db_system: null,
    address: null, port: null, namespace: null, first_seen: '1', last_seen: '1' }
  const backend: NodeView = { ...frontend, id: 'api', label: 'Live API', kind: 'service' }
  const snapshot: GraphView = { nodes: [frontend, backend], edges: [], generated_at: '1' }
  await page.route('**/api/graph', (route) => route.fulfill({ json: snapshot }))
  // Control event timing while exercising the production feed, reducer, renderer and selection UI.
  await page.addInitScript(() => {
    class Feed extends EventTarget {
      static CLOSED = 2
      readyState = 0
      onopen: ((event: Event) => void) | null = null
      constructor() {
        super()
        ;(window as unknown as { lensEvents: EventTarget }).lensEvents = this
        setTimeout(() => {
          if (this.readyState === 2) return
          this.readyState = 1
          this.onopen?.(new Event('open'))
        }, 0)
      }
      close() { this.readyState = 2 }
    }
    Object.defineProperty(window, 'EventSource', { value: Feed })
  })
  await page.goto('/')
  const summary = page.getByRole('region', { name: 'Map as text' })
  await expect(summary).toContainText('Live web')
  const canvas = page.locator('canvas')
  await canvas.focus()
  await canvas.press('ArrowRight')
  const details = page.getByRole('complementary', { name: 'Selection details' })
  await expect(details).toContainText('Technology not reported')

  const updates: NodeView[] = [
    { ...backend, last_seen: '2', metadata: { technologies: ['rust', 'axum', 'sqlx', 'tokio'], pages: [], microfrontends: [] } },
    { ...frontend, last_seen: '2', metadata: { technologies: ['react', 'rust'], pages: ['/'],
      microfrontends: [{ name: 'Account', framework: 'vue', pages: ['/account', '/settings'] }] } },
    { ...frontend, id: 'cache', label: 'Session store', kind: 'database', db_system: 'redis', last_seen: '2' },
  ]
  await page.evaluate((nodes) => {
    const events = (window as unknown as { lensEvents: EventTarget }).lensEvents
    for (const node of nodes) events.dispatchEvent(new MessageEvent('node', { data: JSON.stringify(node) }))
  }, updates)
  // The selected node refreshes in place; frontend filtering does not hide backend libraries.
  await expect(details.getByRole('region', { name: 'Technology stack' })).toContainText('Rust · axum · SQLx · Tokio')
  await expect(summary).toContainText('Account (Vue)')
  await expect(summary).toContainText('Session store (database) — Cache')
  await canvas.press('ArrowRight')
  await canvas.press('ArrowRight')
  await expect(details.getByRole('region', { name: 'Technology stack' })).toContainText('React · Vue')
  await expect(details.getByRole('region', { name: 'Technology stack' })).not.toContainText('Rust')
  await expect(details.getByRole('region', { name: 'Pages', exact: true })).toContainText('/settings')
  expect(errors).toEqual([])
})
