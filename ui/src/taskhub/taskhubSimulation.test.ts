// Core
import { describe, expect, it } from 'vitest'
// Types
import type { DemoCommand, DemoState } from './taskhubSimulation'
// Utils
import { advanceSimulation, initialDemoState, isRunning, MAX_JOURNAL, MAX_NOTIFICATIONS, MAX_TASKS, SCENARIOS, startSimulation } from './taskhubSimulation'
import { taskhubEdges, taskhubNodes, taskhubScene } from './taskhubTopology'
import { taskhubLogos } from './taskhubLogos'
import { NODE_WIDTH } from '../map/layoutGraph'

function finish(state: DemoState, command?: DemoCommand): DemoState {
  let next = command ? startSimulation(state, command) : state
  for (let count = 0; isRunning(next) && count < 100; count++) next = advanceSimulation(next)
  expect(isRunning(next)).toBe(false)
  return next
}

describe('TaskHub topology and simulation', () => {
  it('contains every diagram node, a local technology icon and all four groups', () => {
    expect(taskhubNodes).toHaveLength(19)
    expect(new Set(taskhubNodes.map((node) => node.id)).size).toBe(19)
    expect(taskhubNodes.filter((node) => node.group === 'apps')).toHaveLength(9)
    expect(taskhubScene.groups.map((group) => group.label)).toEqual(['Kubernetes Cluster', 'Namespace: edge', 'Namespace: apps', 'Platform & Data'])
    for (const node of taskhubNodes) {
      expect(taskhubLogos[node.id]).toMatch(/\.svg$/)
      expect(taskhubScene.nodes[node.id]!.logo).toBe(taskhubLogos[node.id])
    }
    expect(Object.values(taskhubScene.nodes).filter((node) => node.external)).toHaveLength(8)
    for (const edge of taskhubEdges) {
      expect(taskhubScene.nodes[edge.from]).toBeDefined()
      expect(taskhubScene.nodes[edge.to]).toBeDefined()
      expect(taskhubScene.edges[edge.id]!.points.length).toBeGreaterThanOrEqual(2)
    }
  })

  it('fits detailed live-map cards without overlap and connects routes at their boundaries', () => {
    const cards = Object.values(taskhubScene.nodes)
    for (const [index, node] of cards.entries()) {
      expect(node.width).toBe(NODE_WIDTH)
      expect(node.height).toBe(node.card.height)
      expect(node.card.technologies).toHaveLength(1)
      for (const other of cards.slice(index + 1)) {
        const overlaps = Math.abs(node.position.x - other.position.x) < (node.width + other.width) / 2
          && Math.abs(node.position.y - other.position.y) < (node.height + other.height) / 2
        expect(overlaps).toBe(false)
      }
      if (node.external) {
        expect(node.card.rows).toEqual([])
        expect(node.card.footer).toContain('internal processing unknown')
      }
    }
    for (const edge of taskhubEdges) {
      const points = taskhubScene.edges[edge.id]!.points
      for (const [id, point, side] of [[edge.from, points[0]!, edge.fromPort], [edge.to, points.at(-1)!, edge.toPort]] as const) {
        const node = taskhubScene.nodes[id]!
        const dx = Math.abs(point.x - node.position.x)
        const dy = Math.abs(point.y - node.position.y)
        expect(dx).toBeCloseTo(side === 'left' || side === 'right' ? node.width / 2 : 0, 8)
        expect(dy).toBeCloseTo(side === 'top' || side === 'bottom' ? node.height / 2 : 0, 8)
      }
    }
    expect(taskhubScene.nodes.browser!.card.kind).toBe('frontend')
    expect(taskhubScene.nodes.redis!.card.kind).toBe('cache')
    expect(taskhubScene.nodes.postgres!.card.kind).toBe('database')
  })

  it('saves a task and returns HTTP 201 before indexing and delivering its notification', () => {
    let state = startSimulation(initialDemoState(), { type: 'task', value: '  New feature  ' })
    while (!state.journal.some((entry) => entry.edgeId === 'browser:dns' && entry.reverse)) state = advanceSimulation(state)
    expect(state.tasks.at(-1)).toMatchObject({ title: 'New feature', indexed: false })
    expect(state.notifications).toEqual([])
    expect(state.journal.at(-1)?.label).toBe('201')
    state = finish(state)
    expect(state.tasks.at(-1)?.indexed).toBe(true)
    expect(state.notifications).toEqual([{ id: 1, taskId: 1, text: 'Task created', delivered: true }])
    const event = state.journal.findIndex((entry) => entry.edgeId === 'tasks:rabbitmq')
    const ack = state.journal.findIndex((entry) => entry.edgeId === 'tasks:rabbitmq' && entry.reverse)
    const consumer = state.journal.findIndex((entry) => entry.edgeId === 'rabbitmq:search')
    expect(ack).toBeGreaterThan(event)
    expect(consumer).toBeGreaterThan(ack)
  })

  it('keeps each external dependency opaque, waiting until its caller receives a response', () => {
    let state = initialDemoState()
    const visited = new Set<string>()
    const externalVisited = new Set<string>()
    for (const scenario of SCENARIOS) {
      state = startSimulation(state, { type: scenario.id })
      while (isRunning(state)) {
        const current = state.flow!.steps[state.stepIndex]!
        const edge = taskhubEdges.find((edge) => edge.id === current.edgeId)!
        visited.add(edge.from); visited.add(edge.to)
        expect(['dns:load-balancer', 'load-balancer:envoy']).not.toContain(current.edgeId)
        state = advanceSimulation(state)
        for (const id of current.starts ?? []) {
          visited.add(id); externalVisited.add(id)
          expect(state.external[id]).toMatchObject({ status: 'waiting', response: null })
        }
        for (const id of current.ends ?? []) {
          expect(state.external[id]?.status).toBe('success')
          expect(state.external[id]?.response).toBeTruthy()
        }
      }
      expect(Object.values(state.external).every((boundary) => boundary.status === 'success')).toBe(true)
    }
    expect([...visited].sort()).toEqual(taskhubNodes.map((node) => node.id).sort())
    expect(externalVisited.size).toBe(8)
    expect(state.signedIn).toBe(true)
    expect(state.tasks.at(-1)?.comments).toHaveLength(1)
    expect(state.tasks.at(-1)?.files).toHaveLength(1)
  })

  it('uploads directly to storage and exposes only indexed search results', () => {
    let state = finish(initialDemoState(), { type: 'file', taskId: 0 })
    expect(state.tasks[0]!.files).toEqual(['architecture-notes-1.pdf'])
    expect(state.journal.some((entry) => entry.edgeId === 'browser:storage' && entry.label === 'PUT')).toBe(true)
    expect(state.journal.filter((entry) => entry.label === 'PUT')).toHaveLength(1)
    state = { ...state, tasks: [...state.tasks, { id: 40, title: 'Hidden until indexed', indexed: false, comments: [], files: [] }] }
    state = finish(state, { type: 'search', value: 'hidden' })
    expect(state.searchResults).toEqual([])
    expect(JSON.parse(state.external.opensearch!.response!)).toEqual({ hits: [] })
    state = finish(state, { type: 'search', value: 'PLATFORM' })
    expect(state.searchResults).toEqual([0])
    expect(JSON.parse(state.external.opensearch!.response!).hits[0].title).toBe('Prepare the platform launch')
  })

  it('validates input, rejects stale tasks, and prevents overlapping or repeated completion', () => {
    const initial = initialDemoState()
    expect(() => startSimulation(initial, { type: 'task', value: ' ' })).toThrow('Enter text')
    expect(() => startSimulation(initial, { type: 'task', value: 'a'.repeat(121) })).toThrow('120')
    expect(() => startSimulation(initial, { type: 'comment', taskId: 999 })).toThrow('no longer available')
    const running = startSimulation(initial, { type: 'task' })
    expect(startSimulation(running, { type: 'search' })).toBe(running)
    const done = finish(running)
    expect(advanceSimulation(done)).toBe(done)
    expect(initialDemoState()).toEqual(initial)
  })

  it('bounds task data, notifications, comments, attachments and the journal', () => {
    let state = finish(initialDemoState(), { type: 'search' })
    expect(state.searchResults).toEqual([0])
    for (let index = 0; index < 55; index++) state = finish(state, { type: 'task', value: `Task ${index}` })
    expect(state.tasks).toHaveLength(MAX_TASKS)
    expect(state.notifications).toHaveLength(MAX_NOTIFICATIONS)
    expect(state.journal).toHaveLength(MAX_JOURNAL)
    expect(state.journal.some((entry) => entry.effect === 'searched')).toBe(false)
    expect(state.hasSearched).toBe(true)
    expect(state.searchResults).toEqual([])
    for (let index = 0; index < 10; index++) {
      state = finish(state, { type: 'comment' })
      state = finish(state, { type: 'file' })
    }
    expect(state.tasks.at(-1)!.comments).toHaveLength(8)
    expect(state.tasks.at(-1)!.files).toHaveLength(8)
    expect(Object.keys(state.counts).length).toBeLessThanOrEqual(taskhubEdges.length)
    expect(Object.keys(state.external).length).toBeLessThanOrEqual(8)
  })
})
