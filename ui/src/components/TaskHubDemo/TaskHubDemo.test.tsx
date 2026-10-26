// Core
import { renderToString } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
// Components
import TaskHubDemo from './TaskHubDemo'
import TaskHubApp from './TaskHubApp'
import TaskHubDetails from './TaskHubDetails'
// Utils
import { initialDemoState } from '../../taskhub/taskhubSimulation'
import { taskhubNodes } from '../../taskhub/taskhubTopology'

describe('TaskHub demo rendering', () => {
  it('keeps the full topology and shared canvas UI without introductory copy', () => {
    const html = renderToString(<TaskHubDemo />)
    expect(html).not.toContain('TaskHub · Simulation')
    expect(html).not.toContain('no collector connection')
    expect(html).not.toContain('<header')
    expect(html).not.toContain('<h1')
    expect(html).toContain('class="app taskhub"')
    for (const name of ['Console', 'Settings', 'Open demo app', 'Run scenario', 'Reset demo']) {
      expect(html).toContain(`aria-label="${name}"`)
    }
    expect(html).toContain('TaskHub topology as text')
    for (const node of taskhubNodes) expect(html).toContain(node.label)
    expect(html).toMatch(/<footer class="chepio-footer">.*<\/footer><\/div>$/)
  })
  it('renders user text literally and provides external request/response inspection', () => {
    const state = initialDemoState()
    state.tasks[0]!.title = '<img src=x onerror=alert(1)>'
    const html = renderToString(<TaskHubApp state={state} onRun={() => {}} />)
    expect(html).toContain('&lt;img')
    expect(html).not.toContain('<img src=x')
    const details = renderToString(<TaskHubDetails selection={{ kind: 'node', id: 'postgres' }} counts={{}} onClose={() => {}}
      onSelect={() => {}} onFocus={() => {}} external={{ postgres: { status: 'waiting', request: 'SELECT', response: null, label: 'SELECT' } }} />)
    expect(details).toContain('Waiting for response')
    expect(details).toContain('Internal processing is unknown')
    expect(details).toContain('Sent request')
    expect(details).toContain('Received response')
    expect(details).toContain('postgresql.svg')
  })
})
