// Core
import { describe, expect, it } from 'vitest'
// Types
import type { DemoCommand, DemoState } from '../taskhubSimulation'
// Utils
import TaskHubConsoleSource, { MAX_CONSOLE_ACTIONS, MAX_STEPS } from './TaskHubConsoleSource'
import { advanceSimulation, initialDemoState, isRunning, SCENARIOS, startSimulation } from '../taskhubSimulation'
import { taskhubNodes, taskhubScene } from '../taskhubTopology'

const T0 = 1_792_930_000_000

/** Runs one scenario to its end, syncing after every step as the demo does. */
function finish(source: TaskHubConsoleSource, state: DemoState, command: DemoCommand): DemoState {
  let next = startSimulation(state, command)
  source.sync(next, T0)
  for (let count = 0; isRunning(next) && count < 100; count++) {
    next = advanceSimulation(next)
    source.sync(next, T0 + count)
  }
  expect(isRunning(next)).toBe(false)
  return next
}

function everyScenario(source: TaskHubConsoleSource): DemoState {
  let state = initialDemoState()
  for (const { id } of SCENARIOS) state = finish(source, state, { type: id })
  return state
}

describe('TaskHub console source', () => {
  it('logs every message of every scenario, across the whole stack', async () => {
    const source = new TaskHubConsoleSource()
    everyScenario(source)
    const { entries } = await source.fetchLogs('')
    const { activities } = await source.fetchActivities('')

    expect(activities.map((activity) => activity.title)).toEqual(SCENARIOS.map((scenario) => scenario.label).reverse())
    for (const activity of activities) {
      const detail = await source.fetchActivity(activity.id)
      // The action itself, then one step per simulated message.
      expect(detail.steps[0]!.kind).toBe('action')
      expect(detail.steps).toHaveLength(activity.lines)
      expect((await source.fetchRequest(activity.traces[0]!)).spans).toHaveLength(activity.lines - 1)
    }
    expect(entries).toHaveLength(activities.reduce((sum, activity) => sum + activity.lines, 0))
    // Every component appears in the log: internal ones write their own lines, opaque ones are reached by them.
    const internal = taskhubNodes.filter((node) => !taskhubScene.nodes[node.id]!.external)
    expect(new Set(entries.map((entry) => entry.service))).toEqual(new Set(internal.map((node) => node.label)))
    expect(new Set(entries.flatMap((entry) => entry.nodes))).toEqual(new Set(taskhubNodes.map((node) => node.id)))
    expect(new Set(entries.map((entry) => entry.layer))).toEqual(new Set(['frontend', 'backend', 'database']))
  })

  it('attributes each message to its sender and data-store exchanges to the database layer', async () => {
    const source = new TaskHubConsoleSource()
    finish(source, initialDemoState(), { type: 'task' })
    const { entries } = await source.fetchLogs('')
    const line = (text: string) => entries.find((entry) => entry.text.startsWith(text))!

    expect(line('POST NestJS API BFF → Tasks Service')).toMatchObject({ service: 'NestJS API BFF', layer: 'backend', kind: 'request' })
    expect(line('201 Tasks Service → NestJS API BFF')).toMatchObject({ service: 'Tasks Service', status_code: 201 })
    expect(line('SELECT Projects Service → PostgreSQL')).toMatchObject({ service: 'Projects Service', layer: 'database', kind: 'query' })
    expect(line('ROWS PostgreSQL → Projects Service')).toMatchObject({ service: 'Projects Service', layer: 'database' })
    expect(line('CONSUME RabbitMQ → Search Service')).toMatchObject({ service: 'Search Service', layer: 'backend', kind: 'call' })
    expect(line('PUSH Realtime Gateway → Browser / Client')).toMatchObject({ service: 'Realtime Gateway', kind: 'call' })
    expect(line('HTTPS Browser / Client → DNS / CDN / WAF')).toMatchObject({ service: 'Browser / Client', layer: 'frontend',
      nodes: ['browser', 'dns', 'load-balancer'] })
    const action = (await source.fetchActivities('')).activities[0]!
    const kinds = (await source.fetchActivity(action.id)).steps.map((step) => step.kind)
    expect(new Set(kinds)).toEqual(new Set(['action', 'send', 'receive', 'respond', 'response', 'query', 'result']))
    const request = await source.fetchRequest(action.traces[0]!)
    expect(request.spans.find((span) => span.name.startsWith('ROWS'))!.attributes).toContainEqual(
      { key: 'lens.http.response.body', kind: 'string', values: [expect.stringContaining('rows')] })
  })

  it('serves filtered, paged console requests like the collector', async () => {
    const source = new TaskHubConsoleSource()
    everyScenario(source)
    const all = (await source.fetchLogs('')).entries

    const database = (await source.fetchLogs('layer=database')).entries
    expect(database.length).toBeGreaterThan(0)
    expect(database.every((entry) => entry.layer === 'database')).toBe(true)
    const balancer = (await source.fetchLogs('node=load-balancer')).entries
    expect(balancer.length).toBeGreaterThan(0)
    expect(balancer.every((entry) => entry.nodes.includes('load-balancer'))).toBe(true)
    expect((await source.fetchLogs('edge=search:opensearch')).entries.every((entry) => entry.text.includes('OpenSearch'))).toBe(true)
    expect((await source.fetchLogs('q=keycloak')).entries.length).toBeGreaterThan(0)
    expect((await source.fetchLogs('kind=action')).entries).toHaveLength(SCENARIOS.length)

    // Newest first; `before` continues with strictly older lines.
    const older = await source.fetchLogs('', all[9]!.id)
    expect(older.entries[0]).toEqual(all[10])
    const searches = await source.fetchActivities('edge=search:opensearch')
    expect(searches.activities.map((activity) => activity.title)).toEqual(['Search tasks', 'Create task'])
    expect((await source.fetchActivities('origin=request')).activities).toEqual([])
    const aborted = new AbortController()
    aborted.abort()
    await expect(source.fetchLogs('', undefined, aborted.signal)).rejects.toThrow()
  })

  it('reports a change only once per step and keeps late batched steps', () => {
    const source = new TaskHubConsoleSource()
    let state = startSimulation(initialDemoState(), { type: 'search' })
    expect(source.sync(state, T0)!.lines).toBe(1)
    expect(source.sync(state, T0)).toBeNull()
    state = advanceSimulation(advanceSimulation(advanceSimulation(state)))
    expect(source.sync(state, T0)!.lines).toBe(4)
    expect(source.sync(state, T0)).toBeNull()
    expect(source.sync(initialDemoState(), T0)).toBeNull()
  })

  it('records a failed click as an error action', async () => {
    const source = new TaskHubConsoleSource()
    source.recordAction('Create task', { error: 'Enter text before running this scenario.', now: T0 })
    const [entry] = (await source.fetchLogs('status=error')).entries
    expect(entry).toMatchObject({ kind: 'action', level: 'error', text: 'Create task: Enter text before running this scenario.' })
    expect((await source.fetchActivities('status=error')).activities[0]).toMatchObject({ title: 'Create task', error: true, traces: [] })
  })

  it('bounds actions, steps and requests, and clears everything on reset', async () => {
    const source = new TaskHubConsoleSource()
    const state = finish(source, initialDemoState(), { type: 'signin' })
    const first = (await source.fetchActivities('')).activities[0]!
    for (let index = 0; index < MAX_CONSOLE_ACTIONS; index++) source.recordAction(`click ${index}`, { now: T0 })
    const { activities } = await source.fetchActivities('')
    expect(activities).toHaveLength(MAX_CONSOLE_ACTIONS)
    expect(activities.some((activity) => activity.id === first.id)).toBe(false)
    await expect(source.fetchActivity(first.id)).rejects.toThrow('no longer in memory')
    await expect(source.fetchRequest(first.traces[0]!)).rejects.toThrow('no longer available')
    expect((await source.fetchLogs('')).entries).toHaveLength(MAX_CONSOLE_ACTIONS)

    const message = state.flow!.steps[0]!
    const steps = Array.from({ length: MAX_STEPS + 11 }, () => message)
    const long: DemoState = { ...state, flow: { ...state.flow!, id: 99, steps }, stepIndex: steps.length }
    const activity = source.sync(long, T0)!
    const detail = await source.fetchActivity(activity.id)
    expect(detail.steps).toHaveLength(MAX_STEPS)
    expect(detail.truncated_steps).toBe(12)
    const request = await source.fetchRequest(activity.traces[0]!)
    expect(request.spans).toHaveLength(MAX_STEPS)
    expect(request.request).toMatchObject({ span_count: MAX_STEPS, dropped_spans: 11 })

    source.clear()
    expect((await source.fetchLogs('')).entries).toEqual([])
    expect((await source.fetchActivities('')).activities).toEqual([])
  })
})
