export type Note = { id: number; text: string }

/** Status and raw body of a call whose outcome the page shows as is. */
export type CallResult = { status: number; body: string }

// Fake credentials from the demo API; chepio-lens must show the password and the token as [REDACTED].
const DEMO_CREDENTIALS = { username: 'demo', password: 'demo-password' }

const JSON_HEADERS = { 'Content-Type': 'application/json' }

async function expectOk(response: Response, what: string): Promise<Response> {
  if (!response.ok) throw new Error(`${what} failed with ${response.status}`)
  return response
}

export async function listNotes(): Promise<Note[]> {
  const response = await expectOk(await fetch('/api/notes'), 'Loading notes')
  return response.json()
}

export async function createNote(text: string): Promise<Note> {
  const response = await expectOk(
    await fetch('/api/notes', { method: 'POST', headers: JSON_HEADERS, body: JSON.stringify({ text }) }),
    'Creating the note',
  )
  return response.json()
}

export async function deleteNote(id: number): Promise<void> {
  await expectOk(await fetch(`/api/notes/${id}`, { method: 'DELETE' }), 'Deleting the note')
}

async function call(path: string, init?: RequestInit): Promise<CallResult> {
  const response = await fetch(path, init)
  return { status: response.status, body: await response.text() }
}

export const demoCalls = {
  login: () =>
    call('/api/login', { method: 'POST', headers: JSON_HEADERS, body: JSON.stringify(DEMO_CREDENTIALS) }),
  slow: () => call('/api/slow'),
  fail: () => call('/api/fail'),
}
