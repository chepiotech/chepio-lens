// Core
import { context, propagation, trace } from '@opentelemetry/api'
import { W3CTraceContextPropagator } from '@opentelemetry/core'
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http'
import { OTLPLogExporter } from '@opentelemetry/exporter-logs-otlp-http'
import { LoggerProvider, BatchLogRecordProcessor } from '@opentelemetry/sdk-logs'
import { registerInstrumentations } from '@opentelemetry/instrumentation'
import { FetchInstrumentation } from '@opentelemetry/instrumentation-fetch'
import { defaultResource, resourceFromAttributes } from '@opentelemetry/resources'
import {
  BatchSpanProcessor,
  StackContextManager,
  TracerProvider,
  type Span,
  type SpanProcessor,
} from '@opentelemetry/sdk-trace'
import { ATTR_SERVICE_NAME, ATTR_URL_FULL } from '@opentelemetry/semantic-conventions'
// Domain
import { type CaptureConfig, DEFAULT_BODY_LIMIT, captureRequest, captureResponse } from './capture'
import { Redactor } from './redaction'
// Services
import { captureLogs } from './logCapture/logCapture'
// Consts
import { LENS_REDACTION_COUNT, LENS_SDK_VERSION, SDK_VERSION } from './consts'

/** Every 500 ms instead of OpenTelemetry's 5 s, so the map stays live (docs/architecture/runtime.md). */
const EXPORT_INTERVAL_MS = 500
/**
 * Small batches: a failed export holds the processor for up to the export timeout, and every retry calls `fetch` with
 * the whole batch on the page's main thread. At 512, a page whose collector was down stalled 11–20 ms per attempt
 * (docs/architecture/quality-attributes.md, run H).
 */
const EXPORT_BATCH_SPANS = 64
/** On overflow new spans are dropped; the app is not affected (I1, I9). */
const EXPORT_QUEUE_SPANS = 2_048
/**
 * Shutdown flushes the whole queue at once, one export per batch; the exporter's default of 30 would drop the rest.
 * Stays below the collector's 64 concurrent ingest requests (docs/architecture/runtime.md).
 */
const EXPORT_CONCURRENCY = EXPORT_QUEUE_SPANS / EXPORT_BATCH_SPANS + 1
/** Covers the exporter's own retries; a batch that does not make it in time is dropped. */
const EXPORT_TIMEOUT_MS = 2_000

export type LensOptions = {
  serviceName: string
  /** Collector OTLP base URL, e.g. `http://localhost:4318`. Empty or missing turns the SDK into a no-op. */
  endpoint?: string
  /** Cross-origin URLs that get `traceparent`; same-origin requests always do. Each target must allow the header. */
  propagateTo?: (string | RegExp)[]
  /** Extra keys to mask, added to the defaults (docs/architecture/security.md). */
  redactKeys?: string[]
  /** Capture request and response bodies of text content types (default true); headers are always captured. */
  captureBodies?: boolean
  /** Most bytes of a masked body exported (default 16384). */
  bodyLimit?: number
}

export type Lens = {
  readonly enabled: boolean
  /** Stops capture, flushes pending spans and logs and waits at most the export timeout. Never rejects. */
  shutdown(): Promise<void>
}

const DISABLED: Lens = { enabled: false, shutdown: async () => {} }

let active: Lens | null = null

/**
 * Starts tracing `fetch` calls and capturing console logs and browser actions. A no-op without an endpoint. Never throws: an
 * invalid endpoint prints one warning and disables the SDK, so the app keeps working (I1). A second call while the
 * SDK is running returns the running instance.
 */
export function initLens(options: LensOptions): Lens {
  const endpoint = options.endpoint?.trim()
  if (!endpoint) return DISABLED
  if (active) return active
  let tracesUrl: string
  try {
    tracesUrl = new URL('v1/traces', endpoint.endsWith('/') ? endpoint : `${endpoint}/`).href
  } catch {
    console.warn(`chepio-lens: endpoint ${JSON.stringify(endpoint)} is not a URL; the SDK is off`)
    return DISABLED
  }

  const redactor = new Redactor(options.redactKeys ?? [])
  const capture: CaptureConfig = {
    bodies: options.captureBodies ?? true,
    bodyLimit: options.bodyLimit ?? DEFAULT_BODY_LIMIT,
    redactor,
  }
  const exporter = new OTLPTraceExporter({
    url: tracesUrl,
    timeoutMillis: EXPORT_TIMEOUT_MS,
    concurrencyLimit: EXPORT_CONCURRENCY,
  })
  const provider = new TracerProvider({
    resource: defaultResource().merge(
      resourceFromAttributes({ [ATTR_SERVICE_NAME]: options.serviceName, [LENS_SDK_VERSION]: SDK_VERSION }),
    ),
    spanProcessors: [
      new RedactingProcessor(redactor),
      new BatchSpanProcessor({
        exporter,
        scheduledDelayMillis: EXPORT_INTERVAL_MS,
        maxExportBatchSize: EXPORT_BATCH_SPANS,
        maxQueueSize: EXPORT_QUEUE_SPANS,
        exportTimeoutMillis: EXPORT_TIMEOUT_MS,
      }),
    ],
  })
  trace.setGlobalTracerProvider(provider)
  context.setGlobalContextManager(new StackContextManager().enable())
  propagation.setGlobalPropagator(new W3CTraceContextPropagator())
  // The instrumentation calls `requestHook` synchronously inside the instrumented `fetch`; the outer wrapper below
  // picks the span up there and clones the response before the app can consume it.
  const logsUrl = new URL('v1/logs', endpoint.endsWith('/') ? endpoint : `${endpoint}/`).href
  const logProvider = new LoggerProvider({
    resource: defaultResource().merge(resourceFromAttributes({ [ATTR_SERVICE_NAME]: options.serviceName, [LENS_SDK_VERSION]: SDK_VERSION })),
    processors: [new BatchLogRecordProcessor({
      exporter: new OTLPLogExporter({ url: logsUrl, timeoutMillis: EXPORT_TIMEOUT_MS, concurrencyLimit: EXPORT_CONCURRENCY }),
      scheduledDelayMillis: EXPORT_INTERVAL_MS, maxExportBatchSize: EXPORT_BATCH_SPANS,
      maxQueueSize: EXPORT_QUEUE_SPANS, exportTimeoutMillis: EXPORT_TIMEOUT_MS,
    })],
  })
  const logs = captureLogs(logProvider.getLogger('chepio-lens-web', SDK_VERSION), redactor)
  let handedOver: Span | undefined
  const unregister = registerInstrumentations({
    tracerProvider: provider,
    instrumentations: [
      new FetchInstrumentation({
        ignoreUrls: [tracesUrl, logsUrl],
        propagateTraceHeaderCorsUrls: options.propagateTo ?? [],
        requestHook: (span, request) => {
          handedOver = span as Span
          guard(() => logs.link(span))
          guard(() => captureRequest(span, request, capture))
        },
      }),
    ],
  })
  const instrumented = globalThis.fetch
  const withBodies = Object.assign(
    function fetchWithBodies(this: unknown, ...args: Parameters<typeof fetch>): Promise<Response> {
      handedOver = undefined
      const result = instrumented.apply(this, args)
      const span = handedOver
      handedOver = undefined
      if (!span) return result
      return result.then((response) => {
        guard(() => captureResponse(span, response, capture))
        return response
      })
    },
    // The exporter calls `fetch.__original` so its own requests are not traced; keep that path open.
    { __original: (instrumented as { __original?: typeof fetch }).__original },
  )
  globalThis.fetch = withBodies

  const lens: Lens = {
    enabled: true,
    shutdown: async () => {
      if (active !== lens) return
      active = null
      if (globalThis.fetch === withBodies) globalThis.fetch = instrumented
      unregister()
      logs.stop()
      // A flush that fails, as with the collector down, drops what it held; the app's own shutdown goes on (I1).
      await Promise.allSettled([provider.shutdown(), logProvider.shutdown()])
      trace.disable()
      context.disable()
      propagation.disable()
    },
  }
  active = lens
  return lens
}

/** Capture must never break the app's request (I1). */
function guard(capture: () => void) {
  try {
    capture()
  } catch {
    // Not captured; the request goes on.
  }
}

/** Masks URL query parameters before export (I2, ADR-0004); the collector masks again on ingest. */
class RedactingProcessor implements SpanProcessor {
  // A plain field, not a parameter property: apps type-check this source with `erasableSyntaxOnly` (Vite's template).
  private readonly redactor: Redactor

  constructor(redactor: Redactor) {
    this.redactor = redactor
  }

  // Experimental in OpenTelemetry JS: the last moment the span is still writable. Versions are pinned and
  // `initLens.test.ts` fails if the hook stops being called.
  onEnding(span: Span) {
    const url = span.attributes[ATTR_URL_FULL]
    if (typeof url !== 'string') return
    const redacted = this.redactor.redactUrl(url)
    if (redacted.count === 0) return
    const previous = span.attributes[LENS_REDACTION_COUNT]
    span.setAttribute(ATTR_URL_FULL, redacted.text)
    span.setAttribute(LENS_REDACTION_COUNT, (typeof previous === 'number' ? previous : 0) + redacted.count)
  }

  onStart() {}

  onEnd() {}

  async forceFlush() {}

  async shutdown() {}
}
