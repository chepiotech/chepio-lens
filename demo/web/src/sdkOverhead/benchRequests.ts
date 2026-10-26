// Request mix of the web SDK overhead bench, the same as the Rust SDK's (`demo/api/examples/sdk_overhead.rs`): equal
// parts of a small read, a login with a password to mask, a note read and write of 1000 characters, and a list of
// about 100 KB, more than the 16 KiB body limit. The bench API (`benchApi.ts`) answers these paths.

export const KINDS = ['health', 'login', 'getNote', 'putNote', 'listNotes'] as const
export type Kind = (typeof KINDS)[number]

export const KIND_LABELS: Record<Kind, string> = {
  health: 'GET /bench-api/health',
  login: 'POST /bench-api/login',
  getNote: 'GET /bench-api/notes/{id}',
  putNote: 'PUT /bench-api/notes/{id}',
  listNotes: 'GET /bench-api/notes (100 KB)',
}

export const API_PREFIX = '/bench-api'
/** Notes the bench API serves, ids 1 to `NOTES`; together about 100 KB, as `GET /api/notes` in the demo. */
export const NOTES = 100
export const NOTE_CHARS = 1000

const NOTE_SENTENCE = 'Overhead measurement note. '
export const NOTE_TEXT = NOTE_SENTENCE.repeat(Math.ceil(NOTE_CHARS / NOTE_SENTENCE.length)).slice(0, NOTE_CHARS)
// Fake credentials, as in the demo (I10): the SDK masks the password.
export const LOGIN_BODY = JSON.stringify({ username: 'demo', password: 'demo-password' })
const NOTE_BODY = JSON.stringify({ text: NOTE_TEXT })
const JSON_HEADERS = { 'Content-Type': 'application/json' }

/** `fetch` arguments for one request of the mix, the way `demoApi.ts` calls the demo API. */
export function benchRequest(kind: Kind, note: number): { url: string; init?: RequestInit } {
  switch (kind) {
    case 'health':
      return { url: `${API_PREFIX}/health` }
    case 'login':
      return { url: `${API_PREFIX}/login`, init: { method: 'POST', headers: JSON_HEADERS, body: LOGIN_BODY } }
    case 'getNote':
      return { url: `${API_PREFIX}/notes/${note}` }
    case 'putNote':
      return { url: `${API_PREFIX}/notes/${note}`, init: { method: 'PUT', headers: JSON_HEADERS, body: NOTE_BODY } }
    case 'listNotes':
      return { url: `${API_PREFIX}/notes` }
  }
}
