// Types
import type { BoundaryState, ScenePacket } from '../map/mapScene/mapScene'
// Utils
import { taskhubEdges, taskhubScene } from './taskhubTopology'

export const STEP_MS = 320
export const MAX_TASKS = 50
export const MAX_JOURNAL = 160
export const MAX_NOTIFICATIONS = 50
export type Scenario = 'open' | 'signin' | 'task' | 'comment' | 'file' | 'search'
export type DemoCommand = { type: Scenario; value?: string; taskId?: number }
export type DemoTask = { id: number; title: string; indexed: boolean; comments: string[]; files: string[] }
type Effect = 'signedIn' | 'taskSaved' | 'commentSaved' | 'fileSaved' | 'indexed' | 'notificationSaved' | 'delivered' | 'searched'
export type DemoStep = ScenePacket & { detail: string; phase: 'request' | 'response' | 'async'; effect?: Effect
  starts?: string[]; ends?: string[]; result?: string }
export type DemoFlow = { id: number; title: string; command: DemoCommand; targetId: number; steps: DemoStep[] }
export type JournalEntry = DemoStep & { runId: number; ordinal: number }
export type DemoState = {
  tasks: DemoTask[]; signedIn: boolean
  notifications: { id: number; taskId: number; text: string; delivered: boolean }[]
  searchResults: number[]; searchQuery: string; hasSearched: boolean; journal: JournalEntry[]; counts: Record<string, number>
  flow: DemoFlow | null; stepIndex: number; sequence: number
  external: Record<string, BoundaryState>
}

export const SCENARIOS: { id: Scenario; label: string; description: string }[] = [
  { id: 'task', label: 'Create task', description: 'Save → outbox → search + notification' },
  { id: 'comment', label: 'Add comment', description: 'Comment → event → realtime notification' },
  { id: 'file', label: 'Attach sample file', description: 'Presign → direct upload → confirmation' },
  { id: 'search', label: 'Search tasks', description: 'BFF → Search Service → OpenSearch' },
  { id: 'signin', label: 'Sign in', description: 'Keycloak identity → Redis session' },
  { id: 'open', label: 'Open application', description: 'Web rendering → API → WebSocket connection' },
]

export function initialDemoState(): DemoState {
  return { tasks: [{ id: 0, title: 'Prepare the platform launch', indexed: true, comments: [], files: [] }],
    signedIn: false, notifications: [], searchResults: [], searchQuery: '', hasSearched: false, journal: [], counts: {}, flow: null, stepIndex: 0, sequence: 0, external: {} }
}
export function isRunning(state: DemoState): boolean { return !!state.flow && state.stepIndex < state.flow.steps.length }

function step(edgeId: string, label: string, detail: string, phase: DemoStep['phase'] = 'request', reverse = false, effect?: Effect): DemoStep {
  return { edgeId, label, detail, phase, reverse, effect, durationMs: STEP_MS }
}
const access = () => [
  { ...step('browser:dns', 'HTTPS', 'The caller sends HTTPS through the external access boundary. Its internal routing and processing are not visible.'), starts: ['dns', 'load-balancer'] },
]
const api = () => [...access(), step('envoy:bff', '/api', 'Envoy routes the public API request to the BFF.')]
const exit = (code: string) => [
  { ...step('browser:dns', code, `The caller receives HTTP ${code} through the external boundary. No internal trace is claimed.`, 'response', true),
    ends: ['dns', 'load-balancer'], result: JSON.stringify({ status: Number(code), source: 'simulated upstream response' }) },
]
const response = (code: string) => [step('envoy:bff', code, 'BFF returns the response through Envoy.', 'response', true), ...exit(code)]
const notification = () => [
  step('rabbitmq:notifications', 'CONSUME', 'Notification Worker consumes its own notifications.q message.', 'async'),
  step('notifications:postgres', 'INSERT', 'Persist the notification in notifications_db before sending a transient push.', 'async', false, 'notificationSaved'),
  step('notifications:redis', 'PUBLISH', 'Publish a notification signal through Redis Pub/Sub.', 'async'),
  step('redis:realtime', 'MESSAGE', 'A Realtime Gateway subscriber receives the Redis signal.', 'async'),
  step('realtime:browser', 'PUSH', 'The browser receives its WebSocket notification.', 'async', false, 'delivered'),
]

/** Only caller-visible exchanges cross an opaque dependency. No external service internals are simulated. */
function externalExchanges(steps: DemoStep[]): DemoStep[] {
  const result: DemoStep[] = []
  for (let index = 0; index < steps.length; index++) {
    const current = steps[index]!
    const edge = taskhubEdges.find((item) => item.id === current.edgeId)!
    if (current.starts || current.ends || current.reverse || !taskhubScene.nodes[edge.to]!.external || taskhubScene.nodes[edge.from]!.external) {
      result.push(current)
      continue
    }
    const following = steps[index + 1]
    const paired = following?.edgeId === current.edgeId && following.reverse
    result.push({ ...current, effect: paired ? current.effect : undefined, starts: [edge.to] })
    const reply = paired ? following : step(current.edgeId, edge.to === 'rabbitmq' ? 'ACK' : 'OK',
      'The caller receives a simulated response from the external service.', current.phase === 'async' ? 'async' : 'response', true, current.effect)
    const body = edge.to === 'rabbitmq' ? { publisherConfirm: 'ack' }
      : edge.to === 'keycloak' ? { subject: 'demo-user', authenticated: true }
      : edge.to === 'postgres' ? current.label === 'SELECT' ? { rows: 1 } : { status: 'committed', rowsAffected: 1 }
      : edge.to === 'opensearch' ? current.label === 'INDEX' ? { result: 'created' } : { result: 'query completed' }
      : edge.to === 'storage' ? { status: 200, object: 'architecture-notes.pdf' } : { result: 'OK' }
    result.push({ ...reply, ends: [edge.to], result: JSON.stringify(body, null, 2), durationMs: STEP_MS * 3 })
    if (paired) index++
  }
  return result
}

/** Builds deterministic, bounded illustrative operations. No network, clock, storage or live telemetry. */
export function startSimulation(state: DemoState, input: DemoCommand): DemoState {
  if (isRunning(state)) return state
  const value = (input.value ?? (input.type === 'task' ? 'Ship the onboarding flow' : input.type === 'comment' ? 'Ready for review.' : '')).trim()
  if ((input.type === 'task' || input.type === 'comment') && !value) throw new Error('Enter text before running this scenario.')
  const limit = input.type === 'task' ? 120 : input.type === 'comment' ? 280 : 80
  if (value.length > limit) throw new Error(`Use at most ${limit} characters.`)
  const target = state.tasks.find((task) => task.id === input.taskId) ?? state.tasks.at(-1)
  if ((input.type === 'comment' || input.type === 'file') && !target) throw new Error('Create a task first.')
  if (input.taskId !== undefined && (input.type === 'comment' || input.type === 'file') && !state.tasks.some((task) => task.id === input.taskId)) {
    throw new Error('That task is no longer available. Choose another task.')
  }
  const command = { ...input, value }
  const targetId = input.type === 'task' ? state.sequence + 1 : target?.id ?? 0
  let steps: DemoStep[]
  switch (input.type) {
    case 'task':
      steps = [...api(), step('bff:tasks', 'POST', 'BFF sends the create-task command to Tasks Service.'),
        step('tasks:projects', 'CHECK', 'Tasks Service asks Projects Service to verify project membership.'),
        step('projects:postgres', 'SELECT', 'Read membership from projects_db.'),
        step('projects:postgres', 'ROWS', 'Return the modeled membership result.', 'response', true),
        step('tasks:projects', 'ALLOW', 'Project access is granted in this simulation.', 'response', true),
        step('tasks:postgres', 'TX', 'Write the task and its outbox event in one modeled transaction.'),
        step('tasks:postgres', 'COMMIT', 'Task and outbox are saved together.', 'response', true, 'taskSaved'),
        step('bff:tasks', '201', 'Task creation succeeds independently of downstream consumers.', 'response', true),
        ...response('201'),
        step('tasks:rabbitmq', 'PUBLISH', 'The outbox publisher sends task.created to taskhub.events.', 'async'),
        step('rabbitmq:search', 'CONSUME', 'Search Service consumes its independent search-index.q message.', 'async'),
        step('search:opensearch', 'INDEX', 'The task becomes searchable after the index is updated.', 'async', false, 'indexed'),
        ...notification()]
      break
    case 'comment':
      steps = [...api(), step('bff:comments', 'POST', 'BFF sends a comment to Comments Service.'),
        step('comments:postgres', 'TX', 'Save the comment and comment.created outbox entry in comments_db.'),
        step('comments:postgres', 'COMMIT', 'The comment is saved.', 'response', true, 'commentSaved'),
        step('bff:comments', '201', 'Comments Service returns the saved comment.', 'response', true), ...response('201'),
        step('comments:rabbitmq', 'PUBLISH', 'Publish comment.created to the notification queue binding.', 'async'), ...notification()]
      break
    case 'file':
      steps = [...api(), step('bff:files', 'PRESIGN', 'Ask Files Service for an upload authorization.'),
        step('files:postgres', 'INSERT', 'Create pending attachment metadata in files_db.'),
        step('files:storage', 'SIGN', 'Model a short-lived, private object upload URL.'),
        step('bff:files', '200', 'Return upload authorization to the BFF.', 'response', true), ...response('200'),
        step('browser:storage', 'PUT', 'Upload a synthetic sample directly from the browser to object storage; the BFF carries no file bytes.'),
        step('browser:storage', '200', 'Object storage accepts the modeled sample.', 'response', true),
        ...api(), step('bff:files', 'COMPLETE', 'Confirm the completed upload.'),
        step('files:storage', 'HEAD', 'Files Service checks the modeled object size and type.'),
        step('files:storage', 'OK', 'Object verification succeeds in this simulation.', 'response', true),
        step('files:postgres', 'UPDATE', 'Mark attachment metadata ready.', 'request', false, 'fileSaved'),
        step('bff:files', '201', 'Return the ready attachment.', 'response', true), ...response('201')]
      break
    case 'search':
      steps = [...api(), step('bff:search', 'GET', 'BFF forwards the search query.'),
        step('search:opensearch', 'QUERY', 'Query the task search projection, not the primary task database.'),
        step('search:opensearch', 'RESULTS', 'Return only tasks whose indexing step has completed.', 'response', true, 'searched'),
        step('bff:search', '200', 'Return search results from Search Service.', 'response', true), ...response('200')]
      break
    case 'signin':
      steps = [...access(), step('envoy:keycloak', 'OIDC', 'Model authorization code + PKCE at the identity provider.'),
        step('envoy:keycloak', 'CODE', 'Return a synthetic identity result; no credentials or token are created.', 'response', true),
        step('envoy:bff', 'CALLBACK', 'Route the simulated sign-in callback to the BFF.'),
        step('bff:keycloak', 'VERIFY', 'BFF verifies the modeled identity result.'),
        step('bff:keycloak', 'IDENTITY', 'Identity verification succeeds in the simulation.', 'response', true),
        step('bff:redis', 'SET', 'Model a server-side session in Redis.'),
        step('bff:redis', 'OK', 'The demo identity is now signed in.', 'response', true, 'signedIn'), ...response('200')]
      break
    case 'open':
      steps = [...access(), step('envoy:web', 'GET /', 'Route the document request to Next.js Web.'),
        step('web:bff', 'HTTP', 'The modeled web server asks the BFF for initial project data.'),
        step('bff:projects', 'GET', 'Read project data through Projects Service.'),
        step('projects:postgres', 'SELECT', 'Read the project from its own database.'),
        step('projects:postgres', 'ROWS', 'Return project rows.', 'response', true),
        step('bff:projects', '200', 'Return the project to BFF.', 'response', true),
        step('web:bff', 'JSON', 'Return initial data for rendering.', 'response', true),
        step('envoy:web', 'HTML', 'Return the rendered page.', 'response', true), ...exit('200'),
        ...access(), step('envoy:realtime', '/ws', 'Open the modeled WebSocket connection.'),
        step('envoy:realtime', '101', 'The realtime connection is ready.', 'response', true), ...exit('101')]
  }
  return { ...state, sequence: state.sequence + 1, stepIndex: 0,
    flow: { id: state.sequence + 1, title: SCENARIOS.find((scenario) => scenario.id === input.type)!.label, command, targetId, steps: externalExchanges(steps) } }
}

export function advanceSimulation(state: DemoState): DemoState {
  if (!state.flow || !isRunning(state)) return state
  const { flow } = state
  const current = flow.steps[state.stepIndex]!
  let next: DemoState = { ...state, stepIndex: state.stepIndex + 1,
    journal: [...state.journal, { ...current, runId: flow.id, ordinal: state.stepIndex + 1 }].slice(-MAX_JOURNAL),
    counts: { ...state.counts, [current.edgeId]: (state.counts[current.edgeId] ?? 0) + 1 } }
  const updateTask = (update: (task: DemoTask) => DemoTask) => { next.tasks = next.tasks.map((task) => task.id === flow.targetId ? update(task) : task) }
  switch (current.effect) {
    case 'signedIn': next.signedIn = true; break
    case 'taskSaved':
      next.tasks = [...state.tasks, { id: flow.targetId, title: flow.command.value!, indexed: false, comments: [], files: [] }].slice(-MAX_TASKS)
      next.searchResults = state.searchResults.filter((id) => next.tasks.some((task) => task.id === id))
      break
    case 'commentSaved': updateTask((task) => ({ ...task, comments: [...task.comments, flow.command.value!].slice(-8) })); break
    case 'fileSaved': updateTask((task) => ({ ...task, files: [...task.files, `architecture-notes-${flow.id}.pdf`].slice(-8) })); break
    case 'indexed': updateTask((task) => ({ ...task, indexed: true })); break
    case 'notificationSaved':
      next.notifications = [...state.notifications, { id: flow.id, taskId: flow.targetId,
        text: flow.command.type === 'comment' ? 'New comment on your task' : 'Task created', delivered: false }].slice(-MAX_NOTIFICATIONS)
      break
    case 'delivered': next.notifications = state.notifications.map((item) => item.id === flow.id ? { ...item, delivered: true } : item); break
    case 'searched':
      next.hasSearched = true
      next.searchQuery = flow.command.value ?? ''
      next.searchResults = state.tasks.filter((task) => task.indexed && task.title.toLocaleLowerCase().includes(next.searchQuery.toLocaleLowerCase())).map((task) => task.id)
      break
  }
  for (const id of current.starts ?? []) {
    next.external = { ...next.external, [id]: { status: 'waiting', request: `${current.label}\n${current.detail}`, response: null, label: current.label } }
  }
  for (const id of current.ends ?? []) {
    const body = id === 'opensearch' && current.effect === 'searched'
      ? JSON.stringify({ hits: next.tasks.filter((task) => next.searchResults.includes(task.id)).map(({ id, title }) => ({ id, title })) }, null, 2)
      : current.result ?? '{"result":"OK"}'
    next.external = { ...next.external, [id]: { status: 'success', request: next.external[id]?.request ?? 'Caller request', response: body, label: current.label } }
  }
  return next
}
