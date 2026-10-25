// Header and body capture for fetch spans, by the rules in docs/architecture/security.md ("Body capture"), the same
// as the Rust SDK's `capture.rs`: bodies are masked whole and then cut, because JSON cut at the limit no longer
// parses and its keys could not be masked.

// Core
import type { Span } from '@opentelemetry/api'
// Domain
import type { Redacted, Redactor } from './redaction'
// Consts
import { LENS_REDACTION_COUNT } from './consts'

/** The most of one body kept for redaction; a larger body is recorded by size only. */
export const REDACT_BUFFER = 256 * 1024
/** Default of `bodyLimit`: the most bytes of a redacted body exported. */
export const DEFAULT_BODY_LIMIT = 16 * 1024

export type CaptureConfig = { bodies: boolean; bodyLimit: number; redactor: Redactor }
export type Side = 'request' | 'response'
type TextKind = 'json' | 'form' | 'plain'
type Attributes = Record<string, string | number | boolean | string[]>

/** What was read of a body: at most `REDACT_BUFFER` bytes, and whether that was all of it. */
export type BodyBytes = { bytes: Uint8Array; complete: boolean }

export function textKind(contentType: string | null): TextKind | null {
  const mime = contentType?.split(';')[0]?.trim().toLowerCase()
  if (!mime) return null
  if (mime === 'application/json' || mime.endsWith('+json')) return 'json'
  if (mime === 'application/x-www-form-urlencoded') return 'form'
  if (mime.startsWith('text/')) return 'plain'
  return null
}

/** Every header as `http.<side>.header.<name>`, a string array as in the OpenTelemetry conventions, masked. */
export function headerAttributes(side: Side, headers: Headers, redactor: Redactor) {
  const attributes: Attributes = {}
  let count = 0
  headers.forEach((value, header) => {
    // Browsers already give lowercase names; other `Headers` implementations may not.
    const name = header.toLowerCase()
    const redacted = redactor.redactHeader(name, value)
    count += redacted.count
    attributes[`http.${side}.header.${name}`] = [redacted.text]
  })
  return { attributes, count }
}

/** Reads a body stream until it ends or exceeds `REDACT_BUFFER`, then lets go of it. */
export async function readLimited(stream: ReadableStream<Uint8Array>): Promise<BodyBytes> {
  const reader = stream.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) return { bytes: concat(chunks, size), complete: true }
      size += value.byteLength
      if (size > REDACT_BUFFER) {
        await reader.cancel()
        return { bytes: new Uint8Array(), complete: false }
      }
      chunks.push(value)
    }
  } finally {
    reader.releaseLock()
  }
}

function concat(chunks: Uint8Array[], size: number): Uint8Array {
  const bytes = new Uint8Array(size)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }
  return bytes
}

/** Size, then the masked and cut text when the whole body was read and is small enough to mask. */
export function bodyAttributes(side: Side, kind: TextKind | null, body: BodyBytes, config: CaptureConfig) {
  const attributes: Attributes = {}
  if (body.complete) attributes[`http.${side}.body.size`] = body.bytes.byteLength
  if (!config.bodies || !kind) return { attributes, count: 0 }
  if (!body.complete) {
    attributes[`lens.http.${side}.body.truncated`] = true
    return { attributes, count: 0 }
  }
  if (body.bytes.byteLength === 0) return { attributes, count: 0 }
  const text = new TextDecoder().decode(body.bytes)
  const unchanged: Redacted = { text, count: 0 }
  const redacted =
    kind === 'json'
      ? (config.redactor.redactJson(text) ?? unchanged)
      : kind === 'form'
        ? config.redactor.redactForm(text)
        : unchanged
  const cut = cutUtf8(redacted.text, config.bodyLimit)
  attributes[`lens.http.${side}.body`] = cut.text
  attributes[`lens.http.${side}.body.truncated`] = cut.truncated
  return { attributes, count: redacted.count }
}

/** Cuts `text` to at most `limit` UTF-8 bytes at a character boundary, like the Rust SDK. */
export function cutUtf8(text: string, limit: number): { text: string; truncated: boolean } {
  const bytes = new TextEncoder().encode(text)
  if (bytes.byteLength <= limit) return { text, truncated: false }
  let end = limit
  // Continuation bytes are 10xxxxxx; step back to the start of the character.
  while (end > 0 && ((bytes[end] ?? 0) & 0xc0) === 0x80) end -= 1
  return { text: new TextDecoder().decode(bytes.subarray(0, end)), truncated: true }
}

/** Running total of masked values per span; the URL processor adds its own on top when the span ends. */
const redactions = new WeakMap<Span, number>()

export function setCaptured(span: Span, captured: { attributes: Attributes; count: number }) {
  span.setAttributes(captured.attributes)
  if (captured.count === 0) return
  const total = (redactions.get(span) ?? 0) + captured.count
  redactions.set(span, total)
  span.setAttribute(LENS_REDACTION_COUNT, total)
}

/** Request headers and body. The body is read only when it is text the app passed in directly, or a `Request`. */
export function captureRequest(span: Span, request: Request | RequestInit, config: CaptureConfig) {
  const headers = new Headers(request.headers)
  setCaptured(span, headerAttributes('request', headers, config.redactor))
  const body = request.body
  if (!config.bodies || body === null || body === undefined) return
  if (request instanceof Request) {
    const kind = textKind(headers.get('content-type'))
    if (kind && !request.bodyUsed) void readBody('request', kind, request.clone().body, span, config)
    return
  }
  const text = typeof body === 'string' ? body : body instanceof URLSearchParams ? body.toString() : null
  if (text === null) return
  // fetch's own defaults for these body types, when the app sets no content type.
  const fallback = typeof body === 'string' ? 'text/plain' : 'application/x-www-form-urlencoded'
  const kind = textKind(headers.get('content-type') ?? fallback)
  const bytes = new TextEncoder().encode(text)
  const complete = bytes.byteLength <= REDACT_BUFFER
  setCaptured(span, bodyAttributes('request', kind, { bytes: complete ? bytes : new Uint8Array(), complete }, config))
}

/** Response headers now; the body from a clone, so the app's own response stays untouched. */
export function captureResponse(span: Span, response: Response, config: CaptureConfig) {
  setCaptured(span, headerAttributes('response', response.headers, config.redactor))
  const kind = textKind(response.headers.get('content-type'))
  if (!config.bodies || !kind || response.bodyUsed || !response.body) return
  void readBody('response', kind, response.clone().body, span, config)
}

async function readBody(
  side: Side,
  kind: TextKind,
  stream: ReadableStream<Uint8Array> | null,
  span: Span,
  config: CaptureConfig,
) {
  if (!stream) return
  try {
    const body = await readLimited(stream)
    // The span ends 300 ms after the response body completes; a slower read is dropped, never waited for.
    if (span.isRecording()) setCaptured(span, bodyAttributes(side, kind, body, config))
  } catch {
    // A body that fails to read is simply not captured (I1).
  }
}
