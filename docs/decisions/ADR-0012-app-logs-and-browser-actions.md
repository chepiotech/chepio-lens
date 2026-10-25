# ADR-0012: OTLP logs and synchronous browser action correlation

## Status
Accepted.

## Date
2026-10-25

## Context
The activity panel already derives lines from request and SQL spans. It also needs application logs and user
actions, including records emitted outside a request. The web SDK uses StackContextManager, which does not preserve
context across native `await`. Adding a log must not create a synthetic request or increment an edge counter.

## Decision
- Receive app logs through standard OTLP `/v1/logs` and store them in the existing bounded activity log. Trace and
  span ids are optional. Mask structured keys before shortening data; keep the existing free-text limitation.
- Use the existing Rust tracing layer for app events, excluding sqlx query events already represented as spans.
  Use official OpenTelemetry log providers/exporters in both SDKs with the trace export queue policy. Exclude
  OpenTelemetry and HTTP transport diagnostics from log export: reqwest's worker does not inherit the exporter's
  suppressed context, and its connection-pool events otherwise start a feedback loop. Other tracing layers still
  receive those diagnostics; exporting app use of these transport targets is also excluded.
- Capture browser console calls and click/submit/history activity locally. Event handlers registered after SDK
  initialization run in a synchronous action context. Associate an action with the first fetch started in that
  context, using that fetch's real trace/span ids; do not create an extra root span or a second request.
- Do not infer correlation from a time window. A continuation after `await`, an inline handler, or a handler
  installed before initialization may have no action context. Its log and request remain independently visible.
- Keep one pass-through `addEventListener`/`removeEventListener` wrapper pair after shutdown, backed by weak listener
  keys, so existing wrapped listeners remain removable and duplicate registration retains its identity. Context
  capture stops; console/history wrappers and capture listeners are removed. Reinitialization reuses the same pair.

## Rationale
This meets the local React demo's immediate event-handler path without changing Promise/timer behavior throughout
the application. A real Chromium probe confirmed React click → fetch → action record with matching ids. Unit tests
cover loss of context after `await`, duplicate registration, removal, `once`, abort signals and shutdown. Record
bounds and data contracts are in the architecture documents rather than duplicated here.

## Alternatives considered
- OpenTelemetry user-interaction instrumentation: its README documents limited operation without zone.js and
  ZoneContextManager. Version 0.67.0 matches the existing SDK line; 0.68.0 requires OpenTelemetry 3.x. Source and
  dependency review were performed, but this package was not installed or experimentally benchmarked. The custom
  synchronous path needs no additional interaction/context dependencies and retains the existing fetch root.
- Zone-based async propagation: adds global asynchronous API patches and dependencies to every instrumented app.
  Broad async propagation is not required for the supported synchronous path and needs a separate compatibility
  measurement on a real target application.
- Correlating with the most recent click: incorrectly joins unrelated requests, so rejected.
- Deprecated `Window.event`: browser-dependent and inaccurate for shadow trees, so rejected.

## Consequences
The panel can inspect standalone logs and late-arriving trace context. Some browser actions remain uncorrelated;
the UI reports missing context instead of guessing. Initialize the SDK before rendering/registration of application
handlers. The listener identity shim remains installed once capture has been enabled, even after shutdown.

## Validation / fitness criteria
`collector/tests/app_logs.rs`, Rust `app_logs::tests`, web `logCapture.test.ts`, and browser `app-logs.spec.ts` cover
redaction, filtering, bounds, levels, context, literal rendering, live delivery and supported action correlation.
SDK unavailable-collector tests and the overhead measurement must remain within their budgets.

## Reconsider when
A real connected application requires correlation across async continuations, installs handlers before the SDK,
uses inline handlers, or shows a listener compatibility/performance regression. Compare a supported context
manager in that application before broadening the capture mechanism.

## References
- [OpenTelemetry user-interaction instrumentation](https://github.com/open-telemetry/opentelemetry-js-contrib/blob/main/packages/instrumentation-user-interaction/README.md)
- [OpenTelemetry Rust transport filtering](https://github.com/open-telemetry/opentelemetry-rust/blob/main/opentelemetry-otlp/examples/basic-otlp-http/src/main.rs)
- [OpenTelemetry logs exporter](https://github.com/open-telemetry/opentelemetry-js/blob/main/experimental/packages/exporter-logs-otlp-http/README.md)
- [Window.event limitations](https://developer.mozilla.org/en-US/docs/Web/API/Window/event)
- `../architecture/interfaces.md`, `../architecture/security.md`, `../architecture/runtime.md`
