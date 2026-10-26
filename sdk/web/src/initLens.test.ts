// Core
import { trace } from '@opentelemetry/api'
import { afterEach, describe, expect, it, vi } from 'vitest'
// Services
import { initLens, type Lens } from './initLens'
// Consts
import { SDK_VERSION } from './consts'

const ORIGIN = 'http://localhost:5173'
const ENDPOINT = 'http://localhost:4318'
const TRACES_URL = `${ENDPOINT}/v1/traces`
const SPAN_KIND_CLIENT = 3

type AnyValue = { stringValue?: string; intValue?: number | string; boolValue?: boolean }
type KeyValue = { key: string; value: AnyValue }
type OtlpSpan = { traceId: string; spanId: string; name: string; kind: number; attributes: KeyValue[] }
type OtlpExport = {
  resourceSpans: { resource: { attributes: KeyValue[] }; scopeSpans: { spans: OtlpSpan[] }[] }[]
}
type AppCall = { url: string; headers: Headers }
type Collector = (signal: AbortSignal | undefined) => Promise<Response>

const collectorOk: Collector = async () => new Response('{}', { status: 200 })

/**
 * Replaces `fetch` before the SDK wraps it: the app's own requests get `{"ok":true}`, export requests go to
 * `collector`. Records both, so tests see what the app sent and what the SDK exported.
 */
function fakeNetwork(collector: Collector = collectorOk) {
  const appCalls: AppCall[] = []
  const exports: OtlpExport[] = []
  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = input instanceof Request ? input.url : new URL(String(input), ORIGIN).href
    if (url === TRACES_URL) {
      exports.push(JSON.parse(new TextDecoder().decode(init?.body as Uint8Array)) as OtlpExport)
      return collector(init?.signal ?? undefined)
    }
    appCalls.push({ url, headers: new Headers(input instanceof Request ? input.headers : init?.headers) })
    const response = new Response('{"ok":true}', { status: 200, headers: { 'Content-Type': 'application/json' } })
    Object.defineProperty(response, 'url', { value: url })
    return response
  })
  const spans = () =>
    exports.flatMap((batch) => batch.resourceSpans.flatMap((resource) => resource.scopeSpans.flatMap((s) => s.spans)))
  return { appCalls, exports, spans }
}

function attr(attributes: KeyValue[], key: string): string | number | boolean | undefined {
  const value = attributes.find((attribute) => attribute.key === key)?.value
  if (value?.intValue !== undefined) return Number(value.intValue)
  return value?.stringValue ?? value?.boolValue
}

async function exportedSpan(network: ReturnType<typeof fakeNetwork>, url: string): Promise<OtlpSpan> {
  return vi.waitFor(
    () => {
      const span = network.spans().find((candidate) => attr(candidate.attributes, 'url.full') === url)
      if (!span) throw new Error(`no span for ${url} yet`)
      return span
    },
    { timeout: 3_000, interval: 50 },
  )
}

async function timed<T>(call: () => Promise<T>): Promise<{ value: T; ms: number }> {
  const start = performance.now()
  const value = await call()
  return { value, ms: performance.now() - start }
}

/** A collector that never answers; only the exporter's own timeout ends the request. */
const collectorHanging: Collector = (signal) =>
  new Promise((_, reject) => signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError'))))

let lens: Lens | undefined

afterEach(async () => {
  await lens?.shutdown()
  lens = undefined
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('initLens', () => {
  it('is a no-op without an endpoint', () => {
    const before = globalThis.fetch
    for (const endpoint of [undefined, '', '   ']) {
      expect(initLens({ serviceName: 'demo-web', endpoint }).enabled).toBe(false)
    }
    expect(globalThis.fetch).toBe(before)
    expect(trace.getTracer('test').startSpan('probe').isRecording()).toBe(false)
  })

  it('disables itself with one warning when the endpoint is not a URL', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const before = globalThis.fetch
    expect(initLens({ serviceName: 'demo-web', endpoint: 'not a url' }).enabled).toBe(false)
    expect(warn).toHaveBeenCalledTimes(1)
    expect(globalThis.fetch).toBe(before)
  })

  it('exports one client span per fetch with the service resource, joined by traceparent', async () => {
    const network = fakeNetwork()
    lens = initLens({ serviceName: 'demo-web', endpoint: ENDPOINT })

    const response = await fetch('/api/notes')
    expect(await response.json()).toEqual({ ok: true })

    const span = await exportedSpan(network, `${ORIGIN}/api/notes`)
    expect(span.kind).toBe(SPAN_KIND_CLIENT)
    expect(attr(span.attributes, 'http.request.method')).toBe('GET')
    expect(attr(span.attributes, 'http.response.status_code')).toBe(200)
    const resource = network.exports[0]?.resourceSpans[0]?.resource.attributes ?? []
    expect(attr(resource, 'service.name')).toBe('demo-web')
    expect(attr(resource, 'telemetry.sdk.language')).toBe('webjs')
    expect(attr(resource, 'lens.sdk.version')).toBe(SDK_VERSION)
    expect(network.appCalls[0]?.headers.get('traceparent')).toBe(`00-${span.traceId}-${span.spanId}-01`)
    // Export requests are never traced themselves.
    expect(network.spans().some((candidate) => attr(candidate.attributes, 'url.full') === TRACES_URL)).toBe(false)
  })

  it('sends traceparent cross-origin only to the configured targets', async () => {
    const network = fakeNetwork()
    lens = initLens({ serviceName: 'demo-web', endpoint: ENDPOINT, propagateTo: [/^http:\/\/localhost:8080\//] })

    await fetch('http://localhost:8080/api/notes')
    await fetch('http://localhost:9090/api/notes')

    expect(network.appCalls[0]?.headers.get('traceparent')).toMatch(/^00-[0-9a-f]{32}-[0-9a-f]{16}-01$/)
    expect(network.appCalls[1]?.headers.get('traceparent')).toBeNull()
  })

  it('masks query parameters in exported URLs and leaves the request itself alone (I2)', async () => {
    const network = fakeNetwork()
    lens = initLens({ serviceName: 'demo-web', endpoint: ENDPOINT, redactKeys: ['tenant'] })

    await fetch('/api/search?token=abc&tenant=t-1&q=1')

    expect(network.appCalls[0]?.url).toBe(`${ORIGIN}/api/search?token=abc&tenant=t-1&q=1`)
    const span = await exportedSpan(network, `${ORIGIN}/api/search?token=[REDACTED]&tenant=[REDACTED]&q=1`)
    expect(attr(span.attributes, 'lens.redaction.count')).toBe(2)
  })

  it('returns the running instance when called again', () => {
    fakeNetwork()
    lens = initLens({ serviceName: 'demo-web', endpoint: ENDPOINT })
    expect(initLens({ serviceName: 'other', endpoint: ENDPOINT })).toBe(lens)
  })

  // The fetch instrumentation keeps its wrapper after `disable()` and passes calls straight through, so wrappers that
  // other scripts added later stay intact.
  it('stops tracing fetch on shutdown', async () => {
    const network = fakeNetwork()
    lens = initLens({ serviceName: 'demo-web', endpoint: ENDPOINT })
    await lens.shutdown()
    const exportsAtShutdown = network.exports.length

    expect(await (await fetch('/api/after')).json()).toEqual({ ok: true })
    await new Promise((resolve) => setTimeout(resolve, 1_000))

    expect(network.appCalls[0]?.headers.get('traceparent')).toBeNull()
    expect(network.exports.length).toBe(exportsAtShutdown)
  })
})

// I1: the app never fails, blocks or slows down because of chepio-lens.
describe('initLens with a broken collector', () => {
  it('keeps app requests fast and correct when the collector is not running', async () => {
    const network = fakeNetwork(async () => {
      throw new TypeError('Failed to fetch')
    })
    lens = initLens({ serviceName: 'demo-web', endpoint: ENDPOINT })

    for (let i = 0; i < 20; i += 1) {
      const { value, ms } = await timed(async () => (await fetch(`/api/notes/${i}`)).json())
      expect(value).toEqual({ ok: true })
      expect(ms).toBeLessThan(50)
    }
    await vi.waitFor(() => expect(network.exports.length).toBeGreaterThan(0), { timeout: 3_000 })
    expect(await (await fetch('/api/after')).json()).toEqual({ ok: true })
  })

  it('keeps app requests fast and shuts down in bounded time when the collector never answers', async () => {
    const network = fakeNetwork(collectorHanging)
    lens = initLens({ serviceName: 'demo-web', endpoint: ENDPOINT })

    for (let i = 0; i < 20; i += 1) {
      const { ms } = await timed(() => fetch(`/api/notes/${i}`))
      expect(ms).toBeLessThan(50)
    }
    await vi.waitFor(() => expect(network.exports.length).toBeGreaterThan(0), { timeout: 3_000 })
    const { ms } = await timed(() => lens?.shutdown() ?? Promise.resolve())
    expect(ms).toBeLessThan(4_500)
  }, 10_000)

  it('shuts down without an error when the collector is not running and spans and logs are queued', async () => {
    vi.stubGlobal('fetch', async (input: RequestInfo | URL) => {
      const url = input instanceof Request ? input.url : new URL(String(input), ORIGIN).href
      if (url.startsWith(ENDPOINT)) throw new TypeError('Failed to fetch')
      return new Response('{"ok":true}', { status: 200, headers: { 'Content-Type': 'application/json' } })
    })
    vi.spyOn(console, 'info').mockImplementation(() => {})
    lens = initLens({ serviceName: 'demo-web', endpoint: ENDPOINT })

    trace.getTracer('test').startSpan('queued').end()
    console.info('queued log record')
    const { value, ms } = await timed(() => lens?.shutdown() ?? Promise.resolve())

    expect(value).toBeUndefined()
    expect(ms).toBeLessThan(4_500)
  }, 10_000)

  // I9: the export queue is bounded; overflow drops spans instead of growing.
  it('drops spans beyond the export queue', async () => {
    const network = fakeNetwork()
    lens = initLens({ serviceName: 'demo-web', endpoint: ENDPOINT })
    const tracer = trace.getTracer('test')

    for (let i = 0; i < 5_000; i += 1) tracer.startSpan('burst').end()
    await lens.shutdown()

    const exported = network.spans().filter((span) => span.name === 'burst').length
    // At most the queue (2,048) plus the one batch (64) taken out for export while the loop ran.
    expect(exported).toBeGreaterThanOrEqual(2_048)
    expect(exported).toBeLessThanOrEqual(2_048 + 64)
  })

  // A failed export retries its whole batch on the main thread, so batches stay small (quality-attributes.md, run H).
  it('exports at most 64 spans per request', async () => {
    const network = fakeNetwork()
    lens = initLens({ serviceName: 'demo-web', endpoint: ENDPOINT })
    const tracer = trace.getTracer('test')

    for (let i = 0; i < 200; i += 1) tracer.startSpan('batched').end()
    await lens.shutdown()

    const sizes = network.exports.map((batch) =>
      batch.resourceSpans.flatMap((resource) => resource.scopeSpans.flatMap((scope) => scope.spans)).length,
    )
    expect(sizes.reduce((sum, size) => sum + size, 0)).toBe(200)
    expect(Math.max(...sizes)).toBeLessThanOrEqual(64)
  })
})
