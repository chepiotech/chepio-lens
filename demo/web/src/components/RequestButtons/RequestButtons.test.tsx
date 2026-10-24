// Core
import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
// Components
import RequestButtons from './RequestButtons'
// Utils
import { jsonResponse, stubFetch } from '../../testing/stubFetch'

describe('RequestButtons', () => {
  it('logs in with the demo credentials and shows the response', async () => {
    const fetchMock = stubFetch(() => jsonResponse({ token: 'demo-session-token' }))
    render(<RequestButtons />)

    fireEvent.click(screen.getByRole('button', { name: 'Log in' }))

    await screen.findByText('POST /api/login → 200 {"token":"demo-session-token"}')
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/login',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ username: 'demo', password: 'demo-password' }),
      }),
    )
  })

  it('shows the status of a failing request', async () => {
    stubFetch(() => jsonResponse({ error: 'database error' }, 500))
    render(<RequestButtons />)

    fireEvent.click(screen.getByRole('button', { name: 'Failing request' }))

    await screen.findByText('GET /api/fail → 500 {"error":"database error"}')
  })
})
