// Domain
import { REDACTED, type Redactor } from '../redaction'

/** Do not invoke getters, toJSON or custom serializers in application objects. */
export function serializeLog(args: unknown[], redactor: Redactor) {
  const seen = new WeakSet<object>()
  let remaining = 12_000
  let nodes = 0
  let truncated = false
  let masked = 0
  const text = (value: string) => {
    if (value.length > remaining) { truncated = true; return '[TRUNCATED]' }
    remaining -= value.length
    return value
  }
  const visit = (value: unknown, depth: number): unknown => {
    if (++nodes > 128 || depth > 6) { truncated = true; return '[TRUNCATED]' }
    if (typeof value === 'string') {
      if (value.length > remaining) { truncated = true; return '[TRUNCATED]' }
      const redacted = redactor.redactJson(value)
      masked += redacted?.count ?? 0
      return text(redacted?.text ?? value)
    }
    if (value === null || typeof value === 'boolean' || typeof value === 'number') return value
    if (typeof value === 'bigint') return value.toString()
    if (typeof value !== 'object') return `[${typeof value}]`
    if (seen.has(value)) return '[Circular]'
    seen.add(value)
    if (value instanceof Error) {
      const own = (key: string, fallback: string) => {
        const descriptor = Object.getOwnPropertyDescriptor(value, key)
        return descriptor && 'value' in descriptor && typeof descriptor.value === 'string' ? text(descriptor.value) : fallback
      }
      return { name: own('name', 'Error'), message: own('message', ''), stack: own('stack', '') }
    }
    const result: Record<string, unknown> | unknown[] = Array.isArray(value) ? [] : Object.create(null)
    let entries = 0
    for (const key of Object.keys(value)) {
      if (++entries > 32 || nodes > 128 || remaining <= 0) { truncated = true; break }
      // Test the full key before shortening anything, and never read a sensitive value.
      if (redactor.isSensitiveKey(key)) {
        Object.defineProperty(result, text(key), { value: REDACTED, enumerable: true, configurable: true })
        masked += 1
        continue
      }
      const descriptor = Object.getOwnPropertyDescriptor(value, key)
      Object.defineProperty(result, text(key), {
        value: descriptor && 'value' in descriptor ? visit(descriptor.value, depth + 1) : '[Getter]', enumerable: true, configurable: true,
      })
    }
    return result
  }
  const values = args.slice(0, 16).map((arg) => visit(arg, 0))
  truncated ||= args.length > 16
  const body = values.map((value) => typeof value === 'string' ? value : JSON.stringify(value)).join(' ')
  // UTF-8 output is bounded too; masking happened while keys were still intact.
  const bytes = new TextEncoder().encode(body)
  return { body: bytes.length <= 12_288 ? body : new TextDecoder('utf-8', { fatal: false }).decode(bytes.slice(0, 12_285)) + '…',
    masked, truncated: truncated || bytes.length > 12_288 }
}
