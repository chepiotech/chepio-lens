// In-process API of the web SDK overhead bench: fixed answers from the dev server itself, without a database, so
// the latency differences come from the SDK in the browser and not from server or database noise.

// Core
import type { Connect, Plugin } from 'vite'
// Consts
import { API_PREFIX, NOTE_TEXT, NOTES } from './benchRequests'

type Answer = { status: number; body: string }

const note = (id: number) => ({ id, text: NOTE_TEXT })
const HEALTH = JSON.stringify({ status: 'ok' })
// A fake token (I10): the SDK masks it in the captured response body.
const LOGIN = JSON.stringify({ token: 'bench-token-not-a-secret' })
const NOTE_BODIES = Array.from({ length: NOTES }, (_, index) => JSON.stringify(note(index + 1)))
const LIST = JSON.stringify(Array.from({ length: NOTES }, (_, index) => note(index + 1)))
const NOT_FOUND: Answer = { status: 404, body: JSON.stringify({ error: 'not found' }) }

/** The answer to `method` on `path`, or `null` outside the bench API. */
export function answer(method: string, path: string): Answer | null {
  if (!path.startsWith(`${API_PREFIX}/`)) return null
  const route = path.slice(API_PREFIX.length)
  if (method === 'GET' && route === '/health') return { status: 200, body: HEALTH }
  if (method === 'POST' && route === '/login') return { status: 200, body: LOGIN }
  if (method === 'GET' && route === '/notes') return { status: 200, body: LIST }
  const id = /^\/notes\/(\d+)$/.exec(route)?.[1]
  const body = id === undefined ? undefined : NOTE_BODIES[Number(id) - 1]
  if (body !== undefined && (method === 'GET' || method === 'PUT')) return { status: 200, body }
  return NOT_FOUND
}

export const benchApiMiddleware: Connect.NextHandleFunction = (request, response, next) => {
  const found = answer(request.method ?? 'GET', request.url?.split('?')[0] ?? '')
  if (!found) return next()
  // The request body is read to its end first, so the keep-alive connection stays usable.
  request.resume()
  request.on('end', () => {
    response.writeHead(found.status, {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(found.body),
      'Cache-Control': 'no-store',
    })
    response.end(found.body)
  })
}

export function benchApi(): Plugin {
  return {
    name: 'sdk-overhead-bench-api',
    configureServer(server) {
      server.middlewares.use(benchApiMiddleware)
    },
  }
}
