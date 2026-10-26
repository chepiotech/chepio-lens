// Core
import { expect, test, type APIRequestContext } from '@playwright/test'
// Utils
import { DEMO, LENS, waitForQuiet } from './support/collector'

type Activity = { id: string; title: string; lines: number; layers: string[]; origin: string; traces: string[] }
type Step = { kind: string; text: string; service: string }

async function activities(request: APIRequestContext, query: string): Promise<Activity[]> {
  const response = await request.get(`${LENS}/api/activities?${query}`)
  expect(response.status()).toBe(200)
  return (await response.json()).activities
}

async function steps(request: APIRequestContext, id: string): Promise<Step[]> {
  const response = await request.get(`${LENS}/api/activities/${encodeURIComponent(id)}`)
  if (response.status() === 404) return []
  expect(response.status()).toBe(200)
  return (await response.json()).steps
}

const THERE_AND_BACK = ['action', 'send', 'receive', 'query', 'result', 'respond', 'response']

// ADR-0016, I13: one user action, one entry, its chain in call order with what really travelled.
test('one Delete is one action whose steps go there and back with real data; a click that starts nothing is its own', async ({ page, request, context }) => {
  const note = `timeline note ${Date.now()}`
  await page.goto(DEMO)
  await page.getByRole('textbox').first().fill(note)
  await page.getByRole('button', { name: 'Add', exact: true }).click()
  const item = page.locator('li', { hasText: note }).first()
  await expect(item).toBeVisible()
  await waitForQuiet(request)
  expect((await request.post(`${LENS}/api/reset`)).status()).toBe(204)

  // On the item's text, not its button: a click that starts no request.
  await item.click({ position: { x: 3, y: 3 } })
  await item.getByRole('button').first().click()
  await expect(page.locator('li', { hasText: note })).toHaveCount(0)

  // Spans and the action record travel in separate batches; wait until the whole chain is in.
  let deleted: Activity | undefined
  await expect.poll(async () => {
    deleted = (await activities(request, 'origin=action&q=click%20delete'))[0]
    return deleted ? (await steps(request, deleted.id)).map((step) => step.kind) : []
  }, { timeout: 15_000 }).toEqual(THERE_AND_BACK)
  expect(deleted!.lines).toBe(4)
  expect(deleted!.layers).toEqual(['frontend', 'backend', 'database'])
  const chain = await steps(request, deleted!.id)
  expect(chain[1]!.text).toMatch(/^DELETE [^ ]+\/api\/notes\/\d+$/)
  expect(chain[3]!.text).toBe('DELETE FROM notes WHERE id = $1')
  expect(chain[4]!.text).toBe('1 row affected')
  expect(chain[5]!.text).toBe('204')
  expect(chain[6]!.text).toBe('204')

  const lone = await activities(request, 'origin=action&q=click%20span%20in%20li')
  expect(lone).toHaveLength(1)
  expect(lone[0]!.lines).toBe(1)
  expect(lone[0]!.traces).toEqual([])
  expect(lone[0]!.title).toMatch(/^click span in li \(\d+ of \d+\)/)
  expect(lone[0]!.title).not.toContain(note)

  const map = await context.newPage()
  await map.goto(LENS)
  await map.getByRole('button', { name: 'Logs', exact: true }).click()
  const rows = map.getByRole('list', { name: 'Actions' }).locator(':scope > li > button')
  await expect(rows.filter({ hasText: 'click Delete' })).toHaveCount(1)
  await rows.filter({ hasText: 'click Delete' }).click()
  const list = map.getByRole('list', { name: /^Steps of click Delete/ })
  await expect(list.locator('.activity-list__word')).toHaveText([
    'User action', 'Request sent', 'Request received', 'Query sent', 'Database answered', 'Response sent', 'Response received',
  ])
  await expect(list).toContainText('1 row affected')
  await list.getByRole('button', { name: 'Open in inspector' }).nth(3).click()
  await expect(map.getByRole('region', { name: 'Request waterfall' })).toBeVisible()
})
