// Core
import { context, createContextKey, trace, type Context, type Span } from '@opentelemetry/api'
// Consts
import { LENS_ACTION_ID } from '../consts'

/** `time`: epoch milliseconds of the action itself. */
type Emit = (body: string, attributes: Record<string, string | boolean>, scope: Context, time: number) => void
type Action = {
  id: string
  /** The clicked element, kept only while the action is pending: the submit a click on a submit button causes joins it. */
  target: Element | undefined
  scope: Context
  linked: Context | null
  body: string
  time: number
  timer: ReturnType<typeof setTimeout>
}
const ACTION = createContextKey('chepio-lens action')
const CONTROL = 'button,a,input[type="button"],input[type="submit"],[role="button"],form'
const MAX_NAME = 128
const MAX_DESCRIPTION = 256
const MAX_PART = 64
/** How many ancestors the description climbs looking for one with an id, test id or role. */
const MAX_ANCESTOR_DEPTH = 5

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
    action.target = undefined
    try {
      if (enabled) emit(action.body, { 'lens.log.kind': 'action', [LENS_ACTION_ID]: action.id }, action.linked ?? action.scope, action.time)
    } catch { /* A dropped log must not interrupt a pending action or shutdown. */ }
  }
  const onAction = (event: Event) => {
    if (!enabled || events.has(event)) return
    try {
      const target = event.composedPath().find((item): item is Element => item instanceof Element)
      // A click on a submit button submits its form in the same task: one gesture, one action (ADR-0016).
      const causing = event.type === 'submit' ? causingAction(event) : undefined
      if (causing) {
        events.set(event, causing)
        return
      }
      const scope = context.active()
      const action: Action = {
        id: actionId(),
        target: event.type === 'click' ? target : undefined,
        scope,
        linked: null,
        body: `${event.type} ${describeTarget(target)}`,
        time: eventTime(event),
        timer: setTimeout(() => finish(action), 0),
      }
      events.set(event, action)
      pending.add(action)
      if (pending.size > 128) finish(pending.values().next().value!)
    } catch { /* Telemetry metadata must not affect application event handlers. */ }
  }
  /** The action a submit belongs to: one whose handler requested it, or the click on its submit button. */
  const causingAction = (event: Event) => {
    const inHandler = active()
    if (inHandler) return inHandler
    // `requestSubmit()` has no submitter; some DOM implementations report the form itself.
    const submitter = 'submitter' in event && event.submitter instanceof Element && event.submitter !== event.target ? event.submitter : null
    for (const action of pending) {
      if (submitter && action.target && submitter.contains(action.target)) return action
    }
    return undefined
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
        // Inside a click or submit handler the navigation belongs to that action.
        const id = active()?.id ?? actionId()
        emit(`navigate ${path}`, { 'lens.log.kind': 'action', [LENS_ACTION_ID]: id, 'url.path': path, 'lens.log.truncated': path !== pathname }, currentContext(), Date.now())
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
    // Every fetch the handler starts names its action (ADR-0016); the record keeps the first fetch's context (ADR-0012).
    link(span: Span) {
      const action = active()
      if (!action) return
      span.setAttribute(LENS_ACTION_ID, action.id)
      if (!action.linked) action.linked = trace.setSpanContext(action.scope, span.spanContext())
    },
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

/** 16 hex characters, random per action. */
function actionId(): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(8)), (byte) => byte.toString(16).padStart(2, '0')).join('')
}

/**
 * Epoch milliseconds of the event itself, not of the later emit: `timeStamp` counts from the page's time origin.
 * Whole milliseconds, like the `Date.now()` start of OpenTelemetry's browser spans, so an action is never stamped
 * after a fetch it started.
 */
function eventTime(event: Event): number {
  const time = Math.floor(performance.timeOrigin + event.timeStamp)
  return event.timeStamp > 0 && Number.isFinite(time) ? time : Date.now()
}

/** A control's accessible name, as before; otherwise the element's description. */
function describeTarget(target: Element | undefined): string {
  if (!target) return 'element'
  const control = target.closest(CONTROL)
  return (control ? accessibleName(control) : '') || describeElement(control ?? target)
}

function accessibleName(element: Element): string {
  const referenced = element.getAttribute('aria-labelledby')?.split(/\s+/).slice(0, 4)
    .map((id) => document.getElementById(id)?.textContent ?? '').join(' ')
  const name = element.getAttribute('aria-label') || referenced ||
    (element.matches('button,a,[role="button"]') ? element.textContent : '') || ''
  return name.replace(/\s+/g, ' ').trim().slice(0, MAX_NAME)
}

/**
 * Tag, id, two classes, role, test id and name with the position among siblings of the same tag, for the element and
 * its ancestors up to the nearest one with an id, test id or role, e.g. `span in li (3 of 12) in ul in div#notes`.
 * Never the element's text: free text is not masked (I2).
 */
function describeElement(element: Element): string {
  const path = [element]
  for (let current = element.parentElement; current && path.length <= MAX_ANCESTOR_DEPTH; current = current.parentElement) {
    if (current === document.body || current === document.documentElement) break
    path.push(current)
    if (identified(current)) break
  }
  // Without an identified ancestor nearby, the two nearest are enough to tell elements apart.
  const shown = identified(path.at(-1)) ? path : path.slice(0, 3)
  return shown.map((item) => `${selector(item)}${position(item)}`).join(' in ').slice(0, MAX_DESCRIPTION)
}

/** ` (2 of 3)` among the parent's children of the same tag; empty when it is the only one. */
function position(element: Element): string {
  const siblings = Array.from(element.parentElement?.children ?? []).filter((child) => child.tagName === element.tagName)
  return siblings.length > 1 ? ` (${siblings.indexOf(element) + 1} of ${siblings.length})` : ''
}

function selector(element: Element): string {
  const part = (value: string) => value.slice(0, MAX_PART)
  let text = element.tagName.toLowerCase()
  if (element.id) text += `#${part(element.id)}`
  for (const name of Array.from(element.classList).slice(0, 2)) text += `.${part(name)}`
  for (const attribute of ['role', 'data-testid', 'name']) {
    const value = element.getAttribute(attribute)
    if (value) text += `[${attribute}=${part(value)}]`
  }
  return text
}

function identified(element: Element | undefined): boolean {
  return Boolean(element && (element.id || element.hasAttribute('data-testid') || element.hasAttribute('role')))
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
