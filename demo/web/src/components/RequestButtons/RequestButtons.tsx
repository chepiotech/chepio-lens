// Core
import { useState } from 'react'
// Services
import { type CallResult, demoCalls } from '../../services/demoApi'

const BUTTONS = [
  { label: 'Log in', request: 'POST /api/login', run: demoCalls.login },
  { label: 'Slow request', request: 'GET /api/slow', run: demoCalls.slow },
  { label: 'Failing request', request: 'GET /api/fail', run: demoCalls.fail },
]

function RequestButtons() {
  const [last, setLast] = useState<{ request: string; result: CallResult } | null>(null)
  const [pending, setPending] = useState(false)

  async function handleClick(request: string, run: () => Promise<CallResult>) {
    setPending(true)
    try {
      setLast({ request, result: await run() })
    } catch (reason) {
      setLast({ request, result: { status: 0, body: (reason as Error).message } })
    } finally {
      setPending(false)
    }
  }

  return (
    <section aria-labelledby="requests-title">
      <h2 id="requests-title">Requests</h2>
      {BUTTONS.map(({ label, request, run }) => (
        <button key={label} type="button" disabled={pending} onClick={() => handleClick(request, run)}>
          {label}
        </button>
      ))}
      <output aria-label="Last response">
        {last && `${last.request} → ${last.result.status} ${last.result.body}`}
      </output>
    </section>
  )
}

export default RequestButtons
