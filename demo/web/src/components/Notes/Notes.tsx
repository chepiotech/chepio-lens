// Core
import { type FormEvent, useEffect, useState } from 'react'
// Services
import { createNote, deleteNote, listNotes, type Note } from '../../services/demoApi'

function Notes() {
  const [notes, setNotes] = useState<Note[]>([])
  const [text, setText] = useState('')
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    listNotes().then(setNotes, (reason: Error) => setError(reason.message))
  }, [])

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    try {
      const note = await createNote(text)
      setNotes((current) => [note, ...current])
      setText('')
      setError(null)
    } catch (reason) {
      setError((reason as Error).message)
    }
  }

  async function handleDelete(id: number) {
    try {
      await deleteNote(id)
      setNotes((current) => current.filter((note) => note.id !== id))
      setError(null)
    } catch (reason) {
      setError((reason as Error).message)
    }
  }

  return (
    <section aria-labelledby="notes-title">
      <h2 id="notes-title">Notes</h2>
      <form onSubmit={handleSubmit}>
        <input aria-label="Note text" value={text} onChange={(event) => setText(event.target.value)} />
        <button type="submit">Add</button>
      </form>
      {error && <p role="alert">{error}</p>}
      <ul>
        {notes.map((note) => (
          <li key={note.id}>
            <span>{note.text}</span>{' '}
            <button type="button" onClick={() => handleDelete(note.id)} aria-label={`Delete "${note.text}"`}>
              Delete
            </button>
          </li>
        ))}
      </ul>
    </section>
  )
}

export default Notes
