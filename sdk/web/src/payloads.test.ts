// Core
import { afterEach, describe, expect, it, vi } from 'vitest'
// Services
import { initLens, type Lens, type LensOptions } from './initLens'

const ORIGIN = 'http://localhost:5173'
const ENDPOINT = 'http://localhost:4318'
const TRACES_URL = `${ENDPOINT}/v1/traces`
const LOGIN = '{"username":"demo","password":"demo-password"}'
const TOKEN = '{"token":"demo-session-token"}'

type AnyValue = {
  stringValue?: string
  intValue?: number | string
  boolValue?: boolean
  arrayValue?: { values: AnyValue[] }
}
type OtlpSpan = { attributes: { key: string; value: AnyValue }[] }
type OtlpExport = { resourceSpans: { scopeSpans: { spans: OtlpSpan[] }[] }[] }

function value(any: AnyValue | undefined): unknown {
  if (!any) return undefined
  if (any.arrayValue) return any.arrayValue.values.map(value)
  if (any.intValue !== undefined) return Number(any.intValue)
  return any.stringValue ?? any.boolValue
}

/** The demo API as the browser sees it, plus a collector that records what the SDK exports. */
function fakeNetwork() {
  const exports: string[] = []
  const received: { url: string; body: string | null }[] = []
  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(new URL(input instanceof Request ? input.url : String(input), ORIGIN), init)
    if (request.url === TRACES_URL) {
      exports.push(new TextDecoder().decode(init?.body as Uint8Array))
      return new Response('{}')
    }
    received.push({ url: request.url, body: request.method === 'GET' ? null : await request.text() })
    const json = { 'Content-Type': 'application/json' }
    const path = new URL(request.url).pathname
    const response =
      path === '/api/login'
        ? new Response(TOKEN, { headers: { ...json, 'Set-Cookie': 'session=s1' } })
        : path === '/api/stream'
          ? new Response(
              new ReadableStream({
                start(controller) {
                  for (const part of ['one ', 'two ', 'three']) controller.enqueue(new TextEncoder().encode(part))
                  controller.close()
                },
              }),
              { headers: { 'Content-Type': 'text/plain' } },
            )
          : new Response(new Uint8Array([1, 2, 3]), { headers: { 'Content-Type': 'application/octet-stream' } })
    Object.defineProperty(response, 'url', { value: request.url })
    return response
  })
  const spans = () =>
    exports.flatMap((batch) =>
      (JSON.parse(batch) as OtlpExport).resourceSpans.flatMap((resource) =>
        resource.scopeSpans.flatMap((scope) => scope.spans),
      ),
    )
  return { exports, received, spans }
}

async function exported(network: ReturnType<typeof fakeNetwork>, path: string) {
  return vi.waitFor(
    () => {
      const span = network
        .spans()
        .find((candidate) => candidate.attributes.some((a) => a.key === 'url.full' && value(a.value) === `${ORIGIN}${path}`))
      if (!span) throw new Error(`no span for ${path} yet`)
      return Object.fromEntries(span.attributes.map((a) => [a.key, value(a.value)]))
    },
    { timeout: 3_000, interval: 50 },
  )
}

let lens: Lens | undefined

function start(options: Partial<LensOptions> = {}) {
  lens = initLens({ serviceName: 'demo-web', endpoint: ENDPOINT, ...options })
}

afterEach(async () => {
  await lens?.shutdown()
  lens = undefined
  vi.unstubAllGlobals()
})

describe('initLens payload capture', () => {
  it('exports login bodies and headers masked while the app sends and reads the originals (I2)', async () => {
    const network = fakeNetwork()
    start()

    const response = await fetch('/api/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer secret' },
      body: LOGIN,
    })

    expect(await response.json()).toEqual({ token: 'demo-session-token' })
    expect(network.received[0]?.body).toBe(LOGIN)
    const span = await exported(network, '/api/login')
    expect(span['lens.http.request.body']).toBe('{"username":"demo","password":"[REDACTED]"}')
    expect(span['lens.http.response.body']).toBe('{"token":"[REDACTED]"}')
    expect(span['http.request.header.authorization']).toEqual(['[REDACTED]'])
    expect(span['http.request.header.content-type']).toEqual(['application/json'])
    expect(span['http.response.header.content-type']).toEqual(['application/json'])
    expect(span['http.request.body.size']).toBe(LOGIN.length)
    expect(span['http.response.body.size']).toBe(TOKEN.length)
    // Authorization, password, token; `Set-Cookie` is not visible to fetch responses.
    expect(span['lens.redaction.count']).toBe(3)
    const all = network.exports.join('\n')
    for (const secret of ['demo-password', 'demo-session-token', 'Bearer secret']) expect(all).not.toContain(secret)
  })

  it('captures a streamed response from a clone while the app reads all of it', async () => {
    const network = fakeNetwork()
    start()

    const text = await (await fetch('/api/stream')).text()

    expect(text).toBe('one two three')
    expect((await exported(network, '/api/stream'))['lens.http.response.body']).toBe('one two three')
  })

  it('records only the size of binary bodies, and no bodies when capture is off', async () => {
    const network = fakeNetwork()
    start({ captureBodies: false })

    await (await fetch('/api/binary')).arrayBuffer()
    await (await fetch('/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: LOGIN })).json()

    const binary = await exported(network, '/api/binary')
    expect(binary['lens.http.response.body']).toBeUndefined()
    const login = await exported(network, '/api/login')
    expect(login['lens.http.request.body']).toBeUndefined()
    expect(login['lens.http.response.body']).toBeUndefined()
    expect(login['http.request.header.content-type']).toEqual(['application/json'])
  })

  it('cuts long bodies after masking and form bodies by field', async () => {
    const network = fakeNetwork()
    start({ bodyLimit: 30 })

    await fetch('/api/login', {
      method: 'POST',
      body: new URLSearchParams({ username: 'demo', password: 'demo-password', note: 'x'.repeat(50) }),
    })

    const span = await exported(network, '/api/login')
    expect(span['lens.http.request.body']).toBe('username=demo&password=[REDACT')
    expect(span['lens.http.request.body.truncated']).toBe(true)
  })

  it('keeps the exporter out of tracing after wrapping fetch', async () => {
    const network = fakeNetwork()
    start()

    await fetch('/api/binary')
    await exported(network, '/api/binary')

    expect(network.spans().some((span) => span.attributes.some((a) => value(a.value) === TRACES_URL))).toBe(false)
  })
})
