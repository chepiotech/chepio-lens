// Types
import type { ActivityDetailView } from '../../api/generated/ActivityDetailView'
import type { ActivityPageView } from '../../api/generated/ActivityPageView'
import type { ActivityView } from '../../api/generated/ActivityView'
import type { AttributeView } from '../../api/generated/AttributeView'
import type { LayerView } from '../../api/generated/LayerView'
import type { LogEntryView } from '../../api/generated/LogEntryView'
import type { LogPageView } from '../../api/generated/LogPageView'
import type { RequestDetailView } from '../../api/generated/RequestDetailView'
import type { SpanKindView } from '../../api/generated/SpanKindView'
import type { StepKindView } from '../../api/generated/StepKindView'
import type { StepView } from '../../api/generated/StepView'
import type { DemoState, DemoStep } from '../taskhubSimulation'
// Utils
import { taskhubEdges, taskhubGraph, taskhubScene } from '../taskhubTopology'

export const MAX_CONSOLE_ACTIONS = 50
export const MAX_CONSOLE_LINES = 2_000
export const MAX_STEPS = 160
const PAGE = 500
// Exchanges with data stores are database-layer queries and results, as on the live map.
const STORES = new Set(['postgres', 'redis', 'opensearch'])
const BROWSER = taskhubGraph.nodes.browser!.label
const ns = (ms: number) => String(BigInt(Math.trunc(ms)) * 1_000_000n)
const attr = (key: string, value: string): AttributeView => ({ key, kind: 'string', values: [value] })
type Line = { entry: LogEntryView; edge: string; activityId: string }
type Action = { detail: ActivityDetailView; traceId: string | null; offset: number; ordinal: number }

/**
 * Each component logs the messages it sends. A message from an opaque external service is logged by the component
 * it reaches, since nothing inside that service is modeled.
 */
function attribute(message: DemoStep) {
  const edge = taskhubEdges.find((item) => item.id === message.edgeId)!
  const sender = message.reverse ? edge.to : edge.from
  const receiver = message.reverse ? edge.from : edge.to
  const owner = taskhubScene.nodes[sender]!.external ? receiver : sender
  const store = STORES.has(edge.from) || STORES.has(edge.to)
  const kind: StepKindView = owner === sender ? (message.reverse ? 'respond' : store ? 'query' : 'send')
    : message.reverse ? (store ? 'result' : 'response') : 'receive'
  const layer: LayerView = kind === 'query' || kind === 'result' ? 'database' : owner === 'browser' ? 'frontend' : 'backend'
  const spanKind: SpanKindView = kind === 'respond' ? 'server' : kind === 'receive' ? 'consumer'
    : kind === 'send' && message.phase === 'async' ? 'producer' : 'client'
  // The access boundary is one exchange through DNS/CDN/WAF and the load balancer; both belong to its lines.
  const nodes = [...new Set([edge.from, edge.to, ...message.starts ?? [], ...message.ends ?? []])]
  return { edge, sender, receiver, owner, kind, layer, spanKind, nodes }
}

function matches(params: URLSearchParams, entry: LogEntryView, edge: string): boolean {
  return (!params.has('layer') || params.get('layer')!.split(',').includes(entry.layer))
    && (!params.has('node') || entry.nodes.includes(params.get('node')!))
    && (!params.has('edge') || edge === params.get('edge'))
    && (!params.has('status') || entry.error === (params.get('status') === 'error'))
    && (!params.has('kind') || entry.kind === params.get('kind'))
    && (!params.has('level') || entry.level === params.get('level'))
    && (!params.has('q') || `${entry.text} ${entry.service} ${entry.trace_id ?? ''} ${entry.record?.body ?? ''}`.toLowerCase().includes(params.get('q')!.toLowerCase()))
}
function earlier(cursor: string, before: string) {
  const [time, seq] = cursor.split('.').map(BigInt)
  const [beforeTime, beforeSeq] = before.split('.').map(BigInt)
  return time! < beforeTime! || time === beforeTime && seq! < beforeSeq!
}

/**
 * Bounded local data source for the ordinary console: the same pages the collector serves for logs, actions and
 * requests, built from the simulation. Never reads or replaces collector traffic.
 */
export default class TaskHubConsoleSource {
  private sequence = 0
  private actions = new Map<string, Action>()
  private runs = new Map<number, string>()
  private requests = new Map<string, RequestDetailView>()
  private lines: Line[] = []

  clear() {
    this.actions.clear(); this.runs.clear(); this.requests.clear(); this.lines = []; this.sequence = 0
  }

  /** A user action: one row in Actions and one `action` line. A failed one carries its error message. */
  recordAction(title: string, { traceId = null, error, now = Date.now() }: { traceId?: string | null; error?: string; now?: number } = {}): string {
    const time = ns(now)
    const cursor = `${time}.${++this.sequence}`
    const id = `action:taskhub-${this.sequence}`
    const failed = error !== undefined
    const text = failed ? `${title}: ${error}` : title
    const activity: ActivityView = { id, cursor, origin: 'action', title, time, service: BROWSER, duration_ms: null,
      layers: ['frontend'], services: [BROWSER], nodes: ['browser'], traces: traceId ? [traceId] : [], traces_unlisted: 0,
      lines: 1, error: failed, status_code: null }
    const step: StepView = { kind: 'action', layer: 'frontend', service: BROWSER, node: 'browser', trace_id: traceId,
      span_id: null, time, offset_ms: 0, duration_ms: null, text, status_code: null, error: failed,
      level: failed ? 'error' : null, details: [] }
    this.actions.set(id, { detail: { activity, steps: [step], truncated_steps: 0 }, traceId, offset: 0, ordinal: 0 })
    this.lines.push({ activityId: id, edge: '', entry: { id: cursor, time, trace_id: traceId, span_id: null,
      duration_ms: null, layer: 'frontend', kind: 'action', service: BROWSER, nodes: ['browser'], text, status_code: null,
      error: failed, level: failed ? 'error' : null, record: { body: text, attributes: [], truncated: false } } })
    this.trim()
    return id
  }

  /** Records every completed step of the current run; returns its updated action, or null when nothing changed. */
  sync(state: DemoState, now = Date.now()): ActivityView | null {
    const flow = state.flow
    if (!flow) return null
    let id = this.runs.get(flow.id)
    const started = !id
    if (!id) {
      const traceId = flow.id.toString(16).padStart(32, '0')
      id = this.recordAction(flow.title, { traceId, now })
      this.runs.set(flow.id, id)
      this.requests.set(traceId, { request: { trace_id: traceId, name: flow.title, service: BROWSER, method: null,
        route: null, status_code: null, start: ns(now), duration_ms: 0, services: [BROWSER], error: false, span_count: 0,
        dropped_spans: 0, has_root: true, hops: [] }, spans: [] })
    }
    const action = this.actions.get(id)!
    const synced = action.ordinal
    // Include all completed steps even if React batched several updates while the console was closed.
    while (action.ordinal < state.stepIndex) {
      const index = action.ordinal++
      const message = flow.steps[index]!
      const { edge, sender, receiver, owner, kind, layer, spanKind, nodes } = attribute(message)
      const service = taskhubGraph.nodes[owner]!.label
      const text = `${message.label} ${taskhubGraph.nodes[sender]!.label} → ${taskhubGraph.nodes[receiver]!.label}`
      const status = /^\d{3}$/.test(message.label) ? Number(message.label) : null
      const error = status !== null && status >= 400
      const response = message.ends?.map((node) => state.external[node]?.response).find(Boolean) ?? message.result
      const spanId = (index + 1).toString(16).padStart(16, '0')
      const step: StepView = { kind, layer, service, node: owner, trace_id: action.traceId, span_id: spanId, time: ns(now),
        offset_ms: action.offset, duration_ms: message.durationMs, text, status_code: status, error, level: null,
        details: [{ label: 'Message', value: message.detail, kind: 'text', truncated: false },
          ...(response ? [{ label: 'Response body', value: response, kind: 'json' as const, truncated: false }] : [])] }
      const previous = action.detail.activity
      const activity: ActivityView = { ...previous, duration_ms: action.offset + message.durationMs,
        layers: [...new Set([...previous.layers, layer])], services: [...new Set([...previous.services, service])],
        nodes: [...new Set([...previous.nodes, ...nodes])], lines: previous.lines + 1,
        error: previous.error || error, status_code: status ?? previous.status_code }
      const steps = [...action.detail.steps, step]
      action.detail = { activity, steps: steps.slice(-MAX_STEPS),
        truncated_steps: action.detail.truncated_steps + Math.max(0, steps.length - MAX_STEPS) }
      this.lines.push({ activityId: id, edge: edge.id, entry: { id: `${ns(now)}.${++this.sequence}`, time: ns(now),
        trace_id: action.traceId, span_id: spanId, duration_ms: message.durationMs, layer,
        kind: layer === 'database' ? 'query' : message.phase === 'async' ? 'call' : 'request', service, nodes,
        text: `${text} · ${message.detail}`, status_code: status, error, level: null, record: null } })
      const request = this.requests.get(action.traceId!)!
      const attributes = [attr('lens.demo.simulated', 'true'), attr('lens.demo.edge', edge.id), attr('lens.demo.phase', message.phase),
        attr('lens.demo.message', message.detail), attr('server.address', taskhubGraph.nodes[edge.to]!.label)]
      if (response) attributes.push(attr('lens.http.response.body', response), attr('http.response.header.content-type', 'application/json'))
      const spans = [...request.spans, { span_id: spanId, parent_span_id: null, service, layer, kind: spanKind,
        name: `${message.label} ${edge.label}`, start: ns(now), start_offset_ms: action.offset, duration_ms: message.durationMs,
        status: error ? 'error' as const : 'ok' as const, status_message: null, attributes, events: [], truncated_attributes: [] }]
      const kept = spans.slice(-MAX_STEPS)
      this.requests.set(action.traceId!, { request: { ...request.request, duration_ms: activity.duration_ms!,
        services: activity.services, status_code: activity.status_code, error: activity.error, span_count: kept.length,
        dropped_spans: request.request.dropped_spans + spans.length - kept.length }, spans: kept })
      action.offset += message.durationMs
    }
    if (!started && action.ordinal === synced) return null
    this.trim()
    return action.detail.activity
  }

  readonly fetchLogs = async (query: string, before?: string, signal?: AbortSignal): Promise<LogPageView> => {
    signal?.throwIfAborted()
    const params = new URLSearchParams(query)
    const lines = this.lines.filter((line) => matches(params, line.entry, line.edge) && (!before || earlier(line.entry.id, before))).reverse()
    const entries = lines.slice(0, PAGE).map((line) => line.entry)
    return { entries, next_before: lines.length > entries.length ? entries.at(-1)!.id : null }
  }
  readonly fetchActivities = async (query: string, before?: string, signal?: AbortSignal): Promise<ActivityPageView> => {
    signal?.throwIfAborted()
    const params = new URLSearchParams(query)
    const actions = [...this.actions.values()].map((action) => action.detail.activity).filter((activity) => {
      if (before && !earlier(activity.cursor, before) || params.has('origin') && params.get('origin') !== activity.origin) return false
      if (params.has('status') && activity.error !== (params.get('status') === 'error')) return false
      const lineParams = new URLSearchParams(params)
      lineParams.delete('origin'); lineParams.delete('status')
      return this.lines.some((line) => line.activityId === activity.id && matches(lineParams, line.entry, line.edge))
    }).reverse()
    const activities = actions.slice(0, 200)
    return { activities, next_before: actions.length > activities.length ? activities.at(-1)!.cursor : null }
  }
  readonly fetchActivity = async (id: string, signal?: AbortSignal): Promise<ActivityDetailView> => {
    signal?.throwIfAborted()
    const action = this.actions.get(id)
    if (!action) throw new Error('This action is no longer in memory.')
    return action.detail
  }
  readonly fetchRequest = async (id: string, signal?: AbortSignal): Promise<RequestDetailView> => {
    signal?.throwIfAborted()
    const request = this.requests.get(id)
    if (!request) throw new Error('This request is no longer available. Choose another log line.')
    return request
  }

  private trim() {
    while (this.actions.size > MAX_CONSOLE_ACTIONS) {
      const id = this.actions.keys().next().value!
      const action = this.actions.get(id)!
      if (action.traceId) this.requests.delete(action.traceId)
      this.actions.delete(id)
      for (const [run, activityId] of this.runs) if (activityId === id) this.runs.delete(run)
    }
    this.lines = this.lines.filter((line) => this.actions.has(line.activityId)).slice(-MAX_CONSOLE_LINES)
  }
}
