// @vitest-environment node
// Core
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
// Domain
import { benchRequest, KINDS, NOTE_CHARS, NOTE_TEXT, NOTES } from './benchRequests'
// Services
import { benchApiMiddleware } from './benchApi'

let server: Server
let origin = ''

beforeAll(async () => {
  // Requests the bench API does not answer fall through to the next handler, here a plain 418.
  server = createServer((request, response) =>
    benchApiMiddleware(request, response, () => {
      response.writeHead(418)
      response.end()
    }),
  )
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
})

afterAll(async () => {
  await new Promise((resolve) => server.close(resolve))
})

async function call(path: string, init?: RequestInit) {
  const response = await fetch(`${origin}${path}`, init)
  return { response, text: await response.text() }
}

describe('bench API', () => {
  it('answers every request of the mix with uncached JSON', async () => {
    for (const kind of KINDS) {
      const { url, init } = benchRequest(kind, 7)
      const { response, text } = await call(url, init)

      expect(response.status, kind).toBe(200)
      expect(response.headers.get('content-type')).toBe('application/json')
      expect(response.headers.get('cache-control')).toBe('no-store')
      expect(() => JSON.parse(text)).not.toThrow()
    }
  })

  it('serves notes of 1000 characters and a list larger than the 16 KiB body limit', async () => {
    const note = benchRequest('getNote', NOTES)
    const list = benchRequest('listNotes', 1)

    expect(NOTE_TEXT).toHaveLength(NOTE_CHARS)
    expect(JSON.parse((await call(note.url)).text)).toEqual({ id: NOTES, text: NOTE_TEXT })
    const notes = JSON.parse((await call(list.url)).text) as unknown[]
    expect(notes).toHaveLength(NOTES)
    expect(JSON.stringify(notes).length).toBeGreaterThan(100_000)
  })

  it('carries a password in the login request and a token in its answer, both fake, for the SDK to mask', async () => {
    const { url, init } = benchRequest('login', 1)

    expect(JSON.parse(String(init?.body))).toMatchObject({ password: 'demo-password' })
    expect(JSON.parse((await call(url, init)).text)).toEqual({ token: 'bench-token-not-a-secret' })
  })

  it('answers 404 inside the bench API and leaves other paths to the next handler', async () => {
    expect((await call(`/bench-api/notes/${NOTES + 1}`)).response.status).toBe(404)
    expect((await call('/bench-api/notes/1', { method: 'DELETE' })).response.status).toBe(404)
    expect((await call('/bench-api/unknown')).response.status).toBe(404)
    expect((await call('/sdk-overhead.html')).response.status).toBe(418)
    expect((await call('/bench-apix')).response.status).toBe(418)
  })
})
