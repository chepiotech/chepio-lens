// Core
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
// Components
import ActivityList from './ActivityList'
import StepList from './StepList'
// Types
import type { ActivityDetailView } from '../../api/generated/ActivityDetailView'
import type { ActivityView } from '../../api/generated/ActivityView'
import type { StepKindView } from '../../api/generated/StepKindView'
import type { StepView } from '../../api/generated/StepView'

const activity = (overrides: Partial<ActivityView> = {}): ActivityView => ({
  id: 'action:0123456789abcdef', cursor: '1792930000000000000.4', origin: 'action', title: 'click Delete', time: '1792930000000000000',
  service: 'demo-web', duration_ms: 42, layers: ['frontend', 'backend', 'database'], services: ['demo-web', 'demo-api'],
  nodes: [], traces: ['0af7651916cd43dd8448eb211c80319c'], traces_unlisted: 0, lines: 4, error: false, status_code: 204, ...overrides,
})

const step = (kind: StepKindView, text: string, overrides: Partial<StepView> = {}): StepView => ({
  kind, layer: 'backend', service: 'demo-api', node: 'svc:demo-api', trace_id: '0af7651916cd43dd8448eb211c80319c', span_id: '2222222222222222',
  time: '1', offset_ms: -9_998, duration_ms: null, text, status_code: null, error: false, level: null, details: [], ...overrides,
})

const noop = () => {}

describe('ActivityList', () => {
  it('shows one row per activity with its layers, origin, status, duration and line count, collapsed', () => {
    const html = renderToStaticMarkup(<ActivityList activities={[activity(), activity({
      id: 'action:feedfacecafebeef', title: 'click li (2 of 3) in ul#notes', layers: ['frontend'], duration_ms: null, lines: 1, status_code: null,
    })]} revisions={{}} expanded={new Set()} onToggle={noop} onInspect={noop} />)

    expect(html.match(/<li /g)).toHaveLength(2)
    expect(html.match(/aria-expanded="false"/g)).toHaveLength(2)
    expect(html).toContain('click Delete')
    expect(html).toContain('user action')
    expect(html).toContain('42.0 ms')
    expect(html).toContain('4 lines')
    expect(html).toContain('1 line<')
    expect(html.match(/activity-list__tag--/g)).toHaveLength(4)
  })

  it('loads the steps of an expanded activity', () => {
    const html = renderToStaticMarkup(<ActivityList activities={[activity()]} revisions={{}} expanded={new Set(['action:0123456789abcdef'])}
      onToggle={noop} onInspect={noop} />)

    expect(html).toContain('aria-expanded="true"')
    expect(html).toContain('Loading steps…')
  })
})

describe('StepList', () => {
  const detail: ActivityDetailView = {
    activity: activity(),
    steps: [
      step('action', 'click Delete', { layer: 'frontend', service: 'demo-web', offset_ms: 0, trace_id: null, span_id: null }),
      step('send', 'DELETE localhost:5173/api/notes/7', { layer: 'frontend', service: 'demo-web', offset_ms: 2 }),
      step('receive', 'DELETE /api/notes/{id}'),
      step('query', 'DELETE FROM notes WHERE id = $1', { layer: 'database', details: [{ label: 'db.query.text', value: 'DELETE FROM notes WHERE id = $1', kind: 'sql', truncated: false }] }),
      step('result', '1 row affected', { layer: 'database', duration_ms: 2 }),
      step('respond', '204', { duration_ms: 4, details: [{ label: 'response body', value: '<img src=x onerror=alert(1)>', kind: 'text', truncated: true }] }),
      step('response', '204', { layer: 'frontend', service: 'demo-web', offset_ms: 42, duration_ms: 40 }),
    ],
    truncated_steps: 3,
  }

  it('lists the chain there and back in order, with directions and offsets', () => {
    const html = renderToStaticMarkup(<StepList detail={detail} onInspect={noop} />)
    const words = [...html.matchAll(/activity-list__word">([^<]+)</g)].map((match) => match[1])

    expect(words).toEqual(['User action', 'Request sent', 'Request received', 'Query sent', 'Database answered', 'Response sent', 'Response received'])
    expect(html.match(/activity-list__step--out/g)).toHaveLength(3)
    expect(html.match(/activity-list__step--back/g)).toHaveLength(3)
    expect(html).toContain('−9,998 ms')
    expect(html).toContain('the order follows the calls')
    expect(html).toContain('3 more steps not shown.')
    // Every step with a span can open it in the inspector; the action record has none.
    expect(html.match(/Open in inspector/g)).toHaveLength(6)
  })

  // I11: payload text never becomes markup.
  it('renders details as text and marks cut values', () => {
    const html = renderToStaticMarkup(<StepList detail={detail} onInspect={noop} />)

    expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;')
    expect(html).not.toContain('<img')
    expect(html).toContain('response body · cut')
    expect(html).toContain('<pre>DELETE FROM notes WHERE id = $1</pre>')
  })
})
