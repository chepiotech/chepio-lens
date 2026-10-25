// Frame-time harness for the map (docs/architecture/quality-attributes.md, "Map rendering"). Development only:
// `perf.html` is not a build input, so production builds and the collector never contain it. Driven by
// `pnpm --filter demo-e2e perf`; results are published on `window.mapPerf`.

// Utils
import { MapRenderer } from '../map/MapRenderer'
import type { Pulse } from '../map/requestPulses'
import { syntheticGraph } from './syntheticGraph'

const WARM_UP_MS = 2_000
const MEASURE_MS = 10_000
/** Requests started every 100 ms and how long each stays on screen: 10 × 2 s / 0.1 s = 200 animated at once. */
const REQUESTS_PER_TICK = 10
const REQUEST_MS = 2_000

export type MapPerf = {
  frames: number
  animatedRequests: number
  drawMs: { p50: number; p95: number; max: number }
  frameIntervalMs: { p50: number; p95: number; max: number }
  /** Frames that took longer than one 60 Hz interval to arrive. */
  slowFrames: number
}

declare global {
  interface Window {
    mapPerf?: MapPerf
  }
}

function percentile(values: number[], p: number): number {
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))] ?? 0
}

function summary(values: number[]) {
  return { p50: percentile(values, 50), p95: percentile(values, 95), max: Math.max(...values) }
}

const canvas = document.getElementById('map')
if (!(canvas instanceof HTMLCanvasElement)) throw new Error('#map canvas is missing from perf.html')

// Times every draw of the renderer; `draw` is private to TypeScript only.
const drawTimes: number[] = []
let measuring = false
const prototype = MapRenderer.prototype as unknown as { draw: (now: number) => void }
const draw = prototype.draw
prototype.draw = function timedDraw(this: unknown, now: number) {
  const start = performance.now()
  draw.call(this, now)
  if (measuring) drawTimes.push(performance.now() - start)
}

const renderer = new MapRenderer(canvas, () => {})
const graph = syntheticGraph()
renderer.setGraph(graph.nodes, graph.edges)

let request = 0
const ticker = setInterval(() => {
  for (let i = 0; i < REQUESTS_PER_TICK; i += 1) {
    const edge = graph.edges[request % graph.edges.length]
    const next = graph.edges[(request * 7 + 3) % graph.edges.length]
    request += 1
    if (!edge || !next) continue
    const pulses: Pulse[] = [
      { edgeId: edge.id, delayMs: 0, durationMs: REQUEST_MS },
      { edgeId: next.id, delayMs: REQUEST_MS / 4, durationMs: REQUEST_MS / 2 },
    ]
    renderer.pulse(pulses)
  }
}, 100)

const frameTimes: number[] = []
const onFrame = (now: number) => {
  if (measuring) frameTimes.push(now)
  requestAnimationFrame(onFrame)
}
requestAnimationFrame(onFrame)

setTimeout(() => {
  measuring = true
  const startRequests = request
  setTimeout(() => {
    measuring = false
    clearInterval(ticker)
    const intervals = frameTimes.slice(1).map((time, i) => time - (frameTimes[i] ?? time))
    window.mapPerf = {
      frames: drawTimes.length,
      animatedRequests: request - startRequests,
      drawMs: summary(drawTimes),
      frameIntervalMs: summary(intervals),
      slowFrames: intervals.filter((interval) => interval > 1_000 / 60 + 4).length,
    }
    document.title = 'done'
  }, MEASURE_MS)
}, WARM_UP_MS)
