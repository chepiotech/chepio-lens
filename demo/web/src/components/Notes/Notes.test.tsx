// Core
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
// Components
import Notes from './Notes'
// Utils
import { jsonResponse, stubFetch } from '../../testing/stubFetch'

describe('Notes', () => {
  it('lists the notes from the API', async () => {
    stubFetch(() => jsonResponse([{ id: 2, text: 'second' }, { id: 1, text: 'first' }]))
    render(<Notes />)

    const items = await screen.findAllByRole('listitem')
    expect(items.map((item) => item.querySelector('span')?.textContent)).toEqual(['second', 'first'])
  })

  it('adds a created note on top and clears the input', async () => {
    const fetchMock = stubFetch((_url, init) =>
      init?.method === 'POST' ? jsonResponse({ id: 2, text: 'new' }, 201) : jsonResponse([{ id: 1, text: 'old' }]),
    )
    render(<Notes />)
    await screen.findByText('old')

    const input = screen.getByLabelText<HTMLInputElement>('Note text')
    fireEvent.change(input, { target: { value: 'new' } })
    fireEvent.click(screen.getByRole('button', { name: 'Add' }))

    await screen.findByText('new')
    const items = screen.getAllByRole('listitem')
    expect(items.map((item) => item.querySelector('span')?.textContent)).toEqual(['new', 'old'])
    expect(input.value).toBe('')
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/notes',
      expect.objectContaining({ method: 'POST', body: JSON.stringify({ text: 'new' }) }),
    )
  })

  it('removes a deleted note', async () => {
    const fetchMock = stubFetch((_url, init) =>
      init?.method === 'DELETE' ? new Response(null, { status: 204 }) : jsonResponse([{ id: 1, text: 'doomed' }]),
    )
    render(<Notes />)

    fireEvent.click(await screen.findByRole('button', { name: 'Delete "doomed"' }))

    await waitFor(() => expect(screen.queryByText('doomed')).toBeNull())
    expect(fetchMock).toHaveBeenCalledWith('/api/notes/1', { method: 'DELETE' })
  })

  it('shows an error when the API fails', async () => {
    stubFetch(() => jsonResponse({ error: 'database error' }, 500))
    render(<Notes />)

    expect((await screen.findByRole('alert')).textContent).toBe('Loading notes failed with 500')
  })
})
