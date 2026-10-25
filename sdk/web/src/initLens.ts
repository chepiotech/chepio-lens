// Core
import { context, propagation, trace } from '@opentelemetry/api'
import { W3CTraceContextPropagator } from '@opentelemetry/core'
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http'
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
import { Redactor } from './redaction'
// Consts
import { LENS_REDACTION_COUNT, LENS_SDK_VERSION, SDK_VERSION } from './consts'

/** Every 500 ms instead of OpenTelemetry's 5 s, so the map stays live (docs/architecture/runtime.md). */
const EXPORT_INTERVAL_MS = 500
const EXPORT_BATCH_SPANS = 512
/** On overflow new spans are dropped; the app is not affected (I1, I9). */
const EXPORT_QUEUE_SPANS = 2_048
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
}

export type Lens = {
  readonly enabled: boolean
  /** Stops tracing `fetch`, flushes pending spans and waits at most the export timeout. */
  shutdown(): Promise<void>
}

const DISABLED: Lens = { enabled: false, shutdown: async () => {} }

let active: Lens | null = null

/**
 * Starts tracing `fetch` calls and exporting them to the collector. A no-op without an endpoint. Never throws: an
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

  const exporter = new OTLPTraceExporter({ url: tracesUrl, timeoutMillis: EXPORT_TIMEOUT_MS })
  const provider = new TracerProvider({
    resource: defaultResource().merge(
      resourceFromAttributes({ [ATTR_SERVICE_NAME]: options.serviceName, [LENS_SDK_VERSION]: SDK_VERSION }),
    ),
    spanProcessors: [
      new RedactingProcessor(new Redactor(options.redactKeys ?? [])),
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
  const unregister = registerInstrumentations({
    tracerProvider: provider,
    instrumentations: [
      new FetchInstrumentation({ ignoreUrls: [tracesUrl], propagateTraceHeaderCorsUrls: options.propagateTo ?? [] }),
    ],
  })

  const lens: Lens = {
    enabled: true,
    shutdown: async () => {
      if (active !== lens) return
      active = null
      unregister()
      try {
        await provider.shutdown()
      } finally {
        trace.disable()
        context.disable()
        propagation.disable()
      }
    },
  }
  active = lens
  return lens
}

/** Masks URL query parameters before export (I2, ADR-0004); the collector masks again on ingest. */
class RedactingProcessor implements SpanProcessor {
  constructor(private readonly redactor: Redactor) {}

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
