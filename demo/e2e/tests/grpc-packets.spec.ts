// Core
import { expect, test } from '@playwright/test'
// Utils
import { LENS, waitForQuiet } from './support/collector'

test('gRPC packets show RPC status and an error does not stain the next successful arrow', async ({ page, request }) => {
  await waitForQuiet(request)
  expect((await request.post(`${LENS}/api/reset`)).status()).toBe(204)
  await page.addInitScript(() => {
    const state = window as unknown as { rpcPaint: { labels: Record<string, string>; calls: string; edge: { text: string; color: string } | null } }
    state.rpcPaint = { labels: {}, calls: '', edge: null }
    const original = CanvasRenderingContext2D.prototype.fillText
    CanvasRenderingContext2D.prototype.fillText = function (...args: Parameters<typeof original>) {
      const label = args[0]
      if (['gRPC', 'INTERNAL', 'OK'].includes(label)) state.rpcPaint.labels[label] = String(this.fillStyle)
      if (label.startsWith('HTTP · Last ')) state.rpcPaint.edge = { text: label, color: String(this.strokeStyle) }
      if (/^\d+ calls?$/.test(label)) state.rpcPaint.calls = label
      return original.apply(this, args)
    }
  })
  await page.goto(LENS)
  await page.getByRole('button', { name: 'Settings', exact: true }).click()
  await expect(page.getByRole('status')).toHaveText('Live')
  await page.getByRole('button', { name: 'Close settings' }).click()
  const send = async (id: number, failed: boolean) => {
    const start = 1_760_000_000_000_000_000n + BigInt(id) * 1_000_000_000n
    const duration = failed ? 700_000_000n : 60_000n
    const resource = (service: string, kind: number, spanId: string, parentSpanId?: string) => ({
      resource: { attributes: [{ key: 'service.name', value: { stringValue: service } }] },
      scopeSpans: [{ spans: [{
        traceId: id.toString(16).padStart(32, '0'), spanId, parentSpanId, kind,
        name: 'school.Identity/GetUser', startTimeUnixNano: start.toString(), endTimeUnixNano: (start + duration).toString(),
        attributes: [
          { key: 'rpc.system.name', value: { stringValue: 'grpc' } },
          { key: 'rpc.method', value: { stringValue: 'school.Identity/GetUser' } },
          { key: 'rpc.response.status_code', value: { stringValue: failed ? 'INTERNAL' : 'OK' } },
          { key: 'http.response.status_code', value: { intValue: '200' } },
        ],
      }] }],
    })
    expect((await request.post('http://localhost:4318/v1/traces', { data: { resourceSpans: [
      resource('gateway', 3, '0000000000000001'), resource('identity', 2, '0000000000000002', '0000000000000001'),
    ] } })).status()).toBe(200)
  }
  const painted = () => page.evaluate(() => (window as unknown as {
    rpcPaint: { labels: Record<string, string>; calls: string; edge: { text: string; color: string } | null }
  }).rpcPaint)
  await send(1, true)
  await expect(page.locator('canvas')).toHaveAttribute('data-last-packets', 'grpc:school.Identity/GetUser')
  await expect.poll(async () => (await painted()).labels.INTERNAL).toBe('#f7768e')
  await expect.poll(async () => (await painted()).edge?.color).toBe('#f7768e')
  await send(2, false)
  await expect.poll(async () => (await painted()).labels.OK).toBe('#73daca')
  await expect.poll(async () => (await painted()).edge?.text).toBe('HTTP · Last 0.06 ms')
  await expect.poll(async () => (await painted()).calls).toBe('2 calls')
  expect((await painted()).edge?.color).not.toBe('#f7768e')
  await page.getByRole('button', { name: 'Settings', exact: true }).click()
  await page.getByRole('tab', { name: 'Map', exact: true }).click()
  await page.getByText('Legend', { exact: true }).click()
  await expect(page.getByText('gRPC call; response shows RPC status')).toBeVisible()
  await page.screenshot({ path: test.info().outputPath('grpc-map.png') })
})
