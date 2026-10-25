// Core
import { context, diag, trace } from '@opentelemetry/api'
import { afterEach, describe, expect, it, vi } from 'vitest'
// Services
import { initLens, type Lens } from '../initLens'
import { serializeLog } from './serializeLog'
// Domain
import { Redactor } from '../redaction'

let lens: Lens | undefined
afterEach(async () => { await lens?.shutdown(); lens = undefined; vi.unstubAllGlobals(); vi.restoreAllMocks(); document.body.replaceChildren() })

function network() {
  const logs: any[] = []
  const spans: any[] = []
  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = input instanceof Request ? input.url : new URL(String(input), "http://localhost:5173").href
    if (url.includes('/v1/')) {
      const data = JSON.parse(new TextDecoder().decode(init?.body as Uint8Array))
      for (const resource of data.resourceLogs ?? []) for (const scope of resource.scopeLogs) logs.push(...scope.logRecords)
      for (const resource of data.resourceSpans ?? []) for (const scope of resource.scopeSpans) spans.push(...scope.spans)
      return new Response('{}')
    }
    const response = new Response('ok'); Object.defineProperty(response, 'url', { value: url }); return response
  })
  return { logs, spans }
}
function start() { lens = initLens({ serviceName: 'logs-test', endpoint: 'http://localhost:4318', redactKeys: ['tenant'] }); return lens }

describe('application logs', () => {
  it('keeps console arguments unchanged, masks structured data and skips diagnostics', async () => {
    const original = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const net = network(); start()
    const value = { nested: { password: 'fake-password' }, tenant: 42, ok: true }
    console.warn('saved', value)
    diag.warn('diagnostic excluded')
    await lens!.shutdown()
    expect(original).toHaveBeenCalledWith('saved', value)
    expect(value.nested.password).toBe('fake-password')
    expect(net.logs).toHaveLength(1)
    expect(net.logs[0].severityNumber).toBe(13)
    const wire = JSON.stringify(net.logs)
    expect(wire).toContain('[REDACTED]')
    expect(wire).not.toContain('fake-password')
    expect(wire).not.toContain('diagnostic excluded')
    expect(console.warn).toBe(original)
    expect(net.spans).toHaveLength(0)
  })

  it('attaches an active trace context to console records', async () => {
    vi.spyOn(console, 'info').mockImplementation(() => {})
    const net = network(); start()
    const span = trace.getTracer('test').startSpan('work')
    context.with(trace.setSpan(context.active(), span), () => console.info('inside request'))
    span.end()
    await lens!.shutdown()
    expect(net.logs[0].traceId).toBe(span.spanContext().traceId)
    expect(net.logs[0].spanId).toBe(span.spanContext().spanId)
  })

  it('joins a synchronous click to its first fetch and preserves handler lifecycle after shutdown', async () => {
    const net = network(); start()
    const button = document.createElement('button'); button.textContent = 'Save note'; document.body.append(button)
    let calls = 0
    const handler = () => { calls++; void fetch('/save') }
    button.addEventListener('click', handler)
    button.addEventListener('click', handler)
    button.click()
    await new Promise((resolve) => setTimeout(resolve, 400))
    await lens!.shutdown()
    const action = net.logs.find((entry) => entry.body.stringValue === 'click Save note')
    expect(action).toBeDefined()
    expect(action.traceId).toBe(net.spans[0].traceId)
    expect(calls).toBe(1)
    button.addEventListener('click', handler)
    button.click(); expect(calls).toBe(2)
    button.removeEventListener('click', handler)
    button.click(); expect(calls).toBe(2)
    const one = vi.fn(); button.addEventListener('click', one, { once: true }); button.click(); button.click(); expect(one).toHaveBeenCalledTimes(1)
    const abort = new AbortController(); const cancelled = vi.fn()
    button.addEventListener('click', cancelled, { signal: abort.signal }); abort.abort(); button.click(); expect(cancelled).not.toHaveBeenCalled()
  })

  it('keeps application handlers running when reading action metadata fails', async () => {
    const net = network(); start()
    const button = document.createElement('button'); document.body.append(button)
    vi.spyOn(button, 'closest').mockImplementation(() => { throw new Error('metadata unavailable') })
    const handler = vi.fn(); button.addEventListener('click', handler)
    button.click(); await lens!.shutdown()
    expect(handler).toHaveBeenCalledOnce()
    expect(net.logs).toHaveLength(0)
  })

  it('does not guess a link after await and records navigation without query or form values', async () => {
    const net = network(); start()
    const button = document.createElement('button'); button.setAttribute('aria-label', 'Later'); document.body.append(button)
    button.addEventListener('click', async () => { await Promise.resolve(); await fetch('/later') })
    button.click(); history.pushState({}, '', '/next?password=fake-query-secret')
    history.pushState({}, '', '/' + 'path'.repeat(1_000))
    await new Promise((resolve) => setTimeout(resolve, 400)); await lens!.shutdown()
    const action = net.logs.find((entry) => entry.body.stringValue === 'click Later')
    expect(action.traceId).toBeUndefined()
    expect(net.logs.some((entry) => entry.body.stringValue === 'navigate /next')).toBe(true)
    expect(JSON.stringify(net.logs)).not.toContain('fake-query-secret')
    const longNavigation = net.logs.find((entry) => entry.body.stringValue.startsWith('navigate /path'))
    expect(longNavigation.body.stringValue.length).toBeLessThanOrEqual(521)
    expect(longNavigation.attributes).toContainEqual({ key: 'lens.log.truncated', value: { boolValue: true } })
    history.replaceState({}, '', '/')
  })
})

describe('bounded console serialization', () => {
  it('does not invoke getters or toJSON and handles cycles and fake secrets', () => {
    const getter = vi.fn(() => 'fake-getter-secret')
    const value: Record<string, unknown> = { password: 'fake-password', toJSON: vi.fn(() => 'unsafe') }
    Object.defineProperty(value, 'expensive', { get: getter, enumerable: true }); value.self = value
    const result = serializeLog([value, '{"token":"fake-json-secret"}'], new Redactor())
    expect(getter).not.toHaveBeenCalled(); expect(value.toJSON).not.toHaveBeenCalled()
    expect(result.body).toContain('[Circular]'); expect(result.body).toContain('[Getter]')
    expect(result.body).not.toContain('fake-'); expect(result.masked).toBe(2)
  })
  it('bounds deep, wide and multibyte arguments', () => {
    const result = serializeLog([{ text: '🦀'.repeat(9_000), children: Array.from({ length: 1_000 }, () => ({ token: 'fake-secret' })) }], new Redactor())
    expect(result.truncated).toBe(true)
    expect(new TextEncoder().encode(result.body).length).toBeLessThanOrEqual(12_291)
    expect(result.body).not.toContain('fake-secret')
  })
})
