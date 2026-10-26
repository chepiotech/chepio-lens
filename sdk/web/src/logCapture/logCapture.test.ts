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

describe('browser actions (ADR-0016)', () => {
  const attribute = (item: any, key: string) => item?.attributes?.find((entry: any) => entry.key === key)?.value?.stringValue
  const nanos = (value: unknown) => BigInt(String(value))
  /** Exports run every 500 ms and a fetch span ends 300 ms after its response, so wait for what the test needs. */
  const exported = (check: () => void) => vi.waitFor(check, { timeout: 3_000, interval: 50 })

  it('names the action on every fetch its handler starts and keeps the first fetch on the record', async () => {
    const net = network(); start()
    const button = document.createElement('button'); button.textContent = 'Sync'; document.body.append(button)
    button.addEventListener('click', () => { void fetch('/first'); void fetch('/second') })
    button.click()
    await exported(() => { expect(net.spans).toHaveLength(2); expect(net.logs).toHaveLength(1) })
    const action = net.logs[0]
    const id = attribute(action, 'lens.action.id')
    expect(id).toMatch(/^[0-9a-f]{16}$/)
    expect(net.spans.map((span) => attribute(span, 'lens.action.id'))).toEqual([id, id])
    const first = net.spans.find((span) => attribute(span, 'url.full')?.endsWith('/first'))
    expect(action.traceId).toBe(first.traceId)
  })

  it('stamps an action with the time of the event, before the fetch it starts', async () => {
    const net = network(); start()
    const button = document.createElement('button'); button.textContent = 'Save'; document.body.append(button)
    button.addEventListener('click', () => { void fetch('/save') })
    button.click()
    await exported(() => { expect(net.spans).toHaveLength(1); expect(net.logs).toHaveLength(1) })
    expect(nanos(net.logs[0].timeUnixNano)).toBeLessThanOrEqual(nanos(net.spans[0].startTimeUnixNano))
  })

  it('describes a clicked element by attributes and position, never by its text, and logs it without a request', async () => {
    const net = network(); start()
    const list = document.createElement('ul'); list.id = 'notes'; document.body.append(list)
    for (let i = 1; i <= 3; i += 1) {
      const item = document.createElement('li'); item.className = 'note-item done extra'; item.dataset.testid = 'note'
      const text = document.createElement('span'); text.textContent = `fake-personal-text ${i}`; item.append(text)
      list.append(item)
    }
    const second = list.children[1] as HTMLElement
    second.click()
    ;(second.firstElementChild as HTMLElement).click()
    await lens!.shutdown()
    expect(net.logs.map((entry) => entry.body.stringValue)).toEqual([
      'click li.note-item.done[data-testid=note] (2 of 3) in ul#notes',
      'click span in li.note-item.done[data-testid=note] (2 of 3)',
    ])
    expect(JSON.stringify(net.logs)).not.toContain('fake-personal-text')
    for (const action of net.logs) {
      expect(action.traceId).toBeUndefined()
      expect(attribute(action, 'lens.action.id')).toMatch(/^[0-9a-f]{16}$/)
    }
    expect(attribute(net.logs[0], 'lens.action.id')).not.toBe(attribute(net.logs[1], 'lens.action.id'))
  })

  it('describes markup without identifiers by the nearest ancestors and their positions', async () => {
    const net = network(); start()
    const root = document.createElement('div'); root.id = 'app'
    const section = document.createElement('section'); const list = document.createElement('ul')
    for (let i = 1; i <= 3; i += 1) {
      const item = document.createElement('li'); const text = document.createElement('span')
      text.textContent = `fake-personal-text ${i}`; item.append(text); list.append(item)
    }
    section.append(list); root.append(section); document.body.append(root)
    ;(list.children[2]?.firstElementChild as HTMLElement).click()
    await lens!.shutdown()
    expect(net.logs.map((entry) => entry.body.stringValue)).toEqual(['click span in li (3 of 3) in ul in section in div#app'])
  })

  it('makes a click on a submit button and the submit it causes one action, a submit alone its own', async () => {
    const net = network(); start()
    const form = document.createElement('form'); form.id = 'add-note'
    const input = document.createElement('input'); input.name = 'text'
    const submit = document.createElement('button'); submit.type = 'submit'; submit.textContent = 'Add'
    form.append(input, submit); document.body.append(form)
    form.addEventListener('submit', (event) => { event.preventDefault(); void fetch('/notes', { method: 'POST' }) })
    submit.click()
    form.requestSubmit()
    await exported(() => { expect(net.spans).toHaveLength(2); expect(net.logs).toHaveLength(2) })
    const bodies = net.logs.map((entry) => entry.body.stringValue)
    expect(bodies).toEqual(['click Add', 'submit form#add-note'])
    const ids = net.logs.map((entry) => attribute(entry, 'lens.action.id'))
    expect(net.spans.map((span) => attribute(span, 'lens.action.id'))).toEqual(ids)
    expect(net.logs.map((entry) => entry.traceId)).toEqual(net.spans.map((span) => span.traceId))
  })

  it('joins a submit that a click handler requests to that click', async () => {
    const net = network(); start()
    const form = document.createElement('form'); form.id = 'note'
    const save = document.createElement('button'); save.type = 'button'; save.textContent = 'Save'
    form.append(save); document.body.append(form)
    form.addEventListener('submit', (event) => { event.preventDefault(); void fetch('/notes', { method: 'POST' }) })
    save.addEventListener('click', () => form.requestSubmit())
    save.click()
    await exported(() => { expect(net.spans).toHaveLength(1); expect(net.logs).toHaveLength(1) })
    expect(net.logs[0].body.stringValue).toBe('click Save')
    expect(attribute(net.spans[0], 'lens.action.id')).toBe(attribute(net.logs[0], 'lens.action.id'))
  })

  it('keeps the accessible name of a control and describes a control without one', async () => {
    const net = network(); start()
    const toolbar = document.createElement('div'); toolbar.id = 'toolbar'; document.body.append(toolbar)
    const named = document.createElement('button'); named.textContent = 'Save note'
    const icon = document.createElement('button'); icon.className = 'icon'; icon.dataset.testid = 'delete'
    toolbar.append(named, icon)
    named.click(); icon.click()
    await lens!.shutdown()
    expect(net.logs.map((entry) => entry.body.stringValue)).toEqual([
      'click Save note',
      'click button.icon[data-testid=delete] (2 of 2) in div#toolbar',
    ])
  })

  it('gives a navigation inside a click handler the click\'s action id, and one outside its own', async () => {
    const net = network(); start()
    const link = document.createElement('a'); link.textContent = 'Open note'; document.body.append(link)
    link.addEventListener('click', () => history.pushState({}, '', '/notes/7'))
    link.click()
    history.pushState({}, '', '/elsewhere')
    await lens!.shutdown()
    const id = (body: string) => attribute(net.logs.find((entry) => entry.body.stringValue === body), 'lens.action.id')
    expect(id('navigate /notes/7')).toBe(id('click Open note'))
    expect(id('navigate /elsewhere')).toMatch(/^[0-9a-f]{16}$/)
    expect(id('navigate /elsewhere')).not.toBe(id('click Open note'))
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
