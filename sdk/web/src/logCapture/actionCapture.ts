// Core
import { context, createContextKey, trace, type Context, type Span } from '@opentelemetry/api'

type Emit = (body: string, attributes: Record<string, string | boolean>, scope: Context) => void
type Action = { scope: Context; linked: Context | null; body: string; timer: ReturnType<typeof setTimeout> }
const ACTION = createContextKey('chepio-lens action')

/** Synchronous event handlers only: never guess that a later async request belongs to the last click. */
export function captureActions(emit: Emit) {
  const events = new WeakMap<Event, Action>()
  const pending = new Set<Action>()
  let enabled = true
  const active = () => context.active().getValue(ACTION) as Action | undefined
  const currentContext = () => active()?.linked ?? context.active()
  const finish = (action: Action) => {
    if (!pending.delete(action)) return
    clearTimeout(action.timer)
    try {
      if (enabled) emit(action.body, { 'lens.log.kind': 'action' }, action.linked ?? action.scope)
    } catch { /* A dropped log must not interrupt a pending action or shutdown. */ }
  }
  const onAction = (event: Event) => {
    if (!enabled || events.has(event)) return
    try {
      const target = event.composedPath().find((item): item is Element => item instanceof Element)
      const scope = context.active()
      const action: Action = { scope, linked: null, body: `${event.type} ${accessibleLabel(target)}`, timer: setTimeout(() => finish(action), 0) }
      events.set(event, action)
      pending.add(action)
      if (pending.size > 128) finish(pending.values().next().value!)
    } catch { /* Telemetry metadata must not affect application event handlers. */ }
  }
  window.addEventListener('click', onAction, true)
  window.addEventListener('submit', onAction, true)
  const stopScopes = handlerScopes((event) => {
    const action = events.get(event)
    return action?.scope.setValue(ACTION, action)
  })
  const navigate = () => {
    try {
      if (enabled) {
        const pathname = location.pathname
        const path = pathname.slice(0, 512)
        emit(`navigate ${path}`, { 'lens.log.kind': 'action', 'url.path': path, 'lens.log.truncated': path !== pathname }, currentContext())
      }
    } catch { /* Preserve successful history calls if capture fails. */ }
  }
  const originalPush = history.pushState
  const originalReplace = history.replaceState
  const push: typeof history.pushState = function(this: History, ...args) { const result = originalPush.apply(this, args); navigate(); return result }
  const replace: typeof history.replaceState = function(this: History, ...args) { const result = originalReplace.apply(this, args); navigate(); return result }
  history.pushState = push
  history.replaceState = replace
  window.addEventListener('popstate', navigate)
  window.addEventListener('hashchange', navigate)
  return {
    currentContext,
    link(span: Span) { const action = active(); if (action && !action.linked) action.linked = trace.setSpanContext(action.scope, span.spanContext()) },
    stop() {
      for (const action of pending) finish(action)
      enabled = false
      stopScopes()
      if (history.pushState === push) history.pushState = originalPush
      if (history.replaceState === replace) history.replaceState = originalReplace
      window.removeEventListener('click', onAction, true)
      window.removeEventListener('submit', onAction, true)
      window.removeEventListener('popstate', navigate)
      window.removeEventListener('hashchange', navigate)
    },
  }
}

function accessibleLabel(target: Element | undefined): string {
  if (!target) return 'element'
  const element = target.closest('button,a,input[type="button"],input[type="submit"],[role="button"],form') ?? target
  const referenced = element.getAttribute('aria-labelledby')?.split(/\s+/).slice(0, 4)
    .map((id) => document.getElementById(id)?.textContent ?? '').join(' ')
  const name = element.getAttribute('aria-label') || referenced ||
    (element.matches('button,a,[role="button"]') ? element.textContent : '') || element.tagName.toLowerCase()
  return name.replace(/\s+/g, ' ').trim().slice(0, 128)
}

// A single pass-through layer survives shutdown, like OpenTelemetry's fetch wrapper. Keeping the listener identity
// mapping is necessary for removeEventListener and duplicate registration after shutdown. Weak keys retain no DOM.
let scopeForEvent: ((event: Event) => Context | undefined) | undefined
let scopesInstalled = false
function handlerScopes(scope: (event: Event) => Context | undefined) {
  scopeForEvent = scope
  if (!scopesInstalled) {
    scopesInstalled = true
    let proto = Object.getPrototypeOf(document) as typeof EventTarget.prototype
    while (!Object.hasOwn(proto, 'addEventListener')) proto = Object.getPrototypeOf(proto) as typeof EventTarget.prototype
    const add = proto.addEventListener
    const remove = proto.removeEventListener
    const wrappers = new WeakMap<EventListenerOrEventListenerObject, EventListener>()
    const isAction = (type: string) => type === 'click' || type === 'submit'
    proto.addEventListener = function(type, listener, options) {
      if (!listener || !isAction(type)) return add.call(this, type, listener, options)
      let wrapped = wrappers.get(listener)
      if (!wrapped) {
        wrapped = function(this: EventTarget, event: Event) {
          const invoke = () => typeof listener === 'function' ? listener.call(this, event) : listener.handleEvent(event)
          const scope = scopeForEvent?.(event)
          return scope ? context.with(scope, invoke) : invoke()
        }
        wrappers.set(listener, wrapped)
      }
      return add.call(this, type, wrapped, options)
    }
    proto.removeEventListener = function(type, listener, options) {
      const wrapped = listener && isAction(type) ? wrappers.get(listener) : undefined
      if (wrapped) remove.call(this, type, wrapped, options)
      // Also covers handlers installed before initLens.
      remove.call(this, type, listener, options)
    }
  }
  return () => { if (scopeForEvent === scope) scopeForEvent = undefined }
}
