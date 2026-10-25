// Core
import { expect, test } from '@playwright/test'

type Summary = { p50: number; p95: number; max: number }
type MapPerf = {
  frames: number
  animatedRequests: number
  drawMs: Summary
  frameIntervalMs: Summary
  slowFrames: number
}

/** One frame at 60 fps. */
const FRAME_MS = 1_000 / 60

// Budget: 60 fps with 50 nodes, 100 edges and 200 animated requests (docs/architecture/quality-attributes.md).
test('the map draws the target graph within one 60 fps frame', async ({ page }, testInfo) => {
  await page.goto('http://localhost:5174/perf.html')
  await page.waitForFunction(() => document.title === 'done', undefined, { timeout: 30_000 })
  const perf = (await page.evaluate(() => (window as unknown as { mapPerf: MapPerf }).mapPerf)) as MapPerf

  const round = (summary: Summary) => Object.values(summary).map((value) => value.toFixed(2)).join(' / ')
  testInfo.annotations.push({
    type: 'map perf',
    description:
      `${testInfo.project.name}: ${perf.frames} frames, draw p50/p95/max ${round(perf.drawMs)} ms, ` +
      `frame interval p50/p95/max ${round(perf.frameIntervalMs)} ms, ${perf.slowFrames} slow frames, ` +
      `${perf.animatedRequests} requests started`,
  })
  expect(perf.frames).toBeGreaterThan(0)
  expect(perf.drawMs.p95).toBeLessThan(FRAME_MS)
})
