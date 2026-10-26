// Core
import { context, diag, type Context } from '@opentelemetry/api'
import { isTracingSuppressed } from '@opentelemetry/core'
import type { LoggerProvider } from '@opentelemetry/sdk-logs'
// Domain
import type { Redactor } from '../redaction'
// Services
import { captureActions } from './actionCapture'
import { serializeLog } from './serializeLog'

type Logger = ReturnType<LoggerProvider['getLogger']>
const LEVELS = { debug: 5, info: 9, log: 9, warn: 13, error: 17 } as const

export function captureLogs(logger: Logger, redactor: Redactor) {
  let busy = false
  const safely = (work: () => void) => { try { work() } catch { /* Telemetry never breaks the app. */ } }
  const actions = captureActions((body, attributes, scope, time) => safely(() => emit(body, attributes, scope, 9, 'info', time)))
  function emit(body: string, attributes: Record<string, string | number | boolean>, scope: Context, severity = 9, text = 'info', timestamp?: number) {
    logger.emit({ body, attributes, context: scope, severityNumber: severity, severityText: text, ...(timestamp === undefined ? {} : { timestamp }) })
  }
  const restore: (() => void)[] = []
  // Diagnostics may run later, outside the suppressed export context. Mark their synchronous console calls too.
  for (const method of ['debug', 'info', 'warn', 'error', 'verbose'] as const) {
    const original = diag[method]
    const wrapped: typeof original = (...args) => { const previous = busy; busy = true; try { return original(...args) } finally { busy = previous } }
    diag[method] = wrapped
    restore.push(() => { if (diag[method] === wrapped) diag[method] = original })
  }
  for (const method of Object.keys(LEVELS) as (keyof typeof LEVELS)[]) {
    const original = console[method]
    const wrapped: typeof original = function(this: unknown, ...args) {
      const result = original.apply(this, args)
      if (!busy && !isTracingSuppressed(context.active())) {
        busy = true
        safely(() => {
          const serialized = serializeLog(args, redactor)
          emit(serialized.body, { 'lens.redaction.count': serialized.masked, 'lens.log.truncated': serialized.truncated }, actions.currentContext(), LEVELS[method], method === 'log' ? 'info' : method)
        })
        busy = false
      }
      return result
    }
    console[method] = wrapped
    restore.push(() => { if (console[method] === wrapped) console[method] = original })
  }
  return { link: actions.link, stop() { actions.stop(); for (const undo of restore.reverse()) undo() } }
}
