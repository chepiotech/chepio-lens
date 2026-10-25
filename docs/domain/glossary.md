# Glossary

| Term | Meaning |
|---|---|
| Instrumented app | The developer's project that runs a chepio-lens SDK and sends spans to the collector |
| Collector | The chepio-lens server: receives spans, builds the graph, serves the UI |
| SDK | The library added to the instrumented app (Rust SDK for backends, web SDK for browsers) |
| OTLP | OpenTelemetry Protocol, the wire format for sending spans; chepio-lens uses OTLP over HTTP |
| Semantic conventions (semconv) | OpenTelemetry's standard attribute names, e.g. `http.request.method`, `db.query.text`; "legacy" names are older versions of them |
| Trace | All spans of one request across all services; identified by `trace_id` |
| Span | One timed operation inside a trace: a fetch in the browser, a handled HTTP request, a SQL query |
| Span kind | `server` (handles an incoming call), `client` (makes an outgoing call), `internal`, `producer`, `consumer` |
| Resource | Attributes describing who produced a span, e.g. `service.name` |
| `traceparent` | W3C Trace Context header that carries the trace and parent span id from caller to callee |
| Request | chepio-lens view of a trace: its root span plus a summary (method, route, status, duration) |
| Node | A box on the map: frontend, service, database or external |
| External node | A destination that sends no spans itself, known only from a client span's address |
| Edge | An arrow on the map between two nodes for one protocol (http or db), with aggregated stats |
| Link window | How long a client span waits for its server-side child before it is attributed to an external node |
| Payload | Headers, bodies and SQL captured on a span |
| Redaction | Replacing sensitive values in payloads with `[REDACTED]` |
| Resync | The UI dropping its incremental state and loading a fresh graph snapshot |
| Log entry (log line) | One line of the logs panel: a span shown as text with its time, duration, layer and status, or an app log record or user action |
| Log record | An OTLP log sent by an SDK: a Rust `tracing` event or a browser `console.*` call, with a level and, when there is one, the span it happened in |
| User action | A click, form submit or navigation in the browser, sent as a log record of kind `action`; linked to the request it causes only when that request starts synchronously in the same handler (ADR-0012) |
| Layer | Which part of the app a log line belongs to: `frontend` (browser), `backend` (services) or `database` (queries) |
| Hop | One edge a request crossed, with when it started on the request's timeline and how long it took |
| Packet | What travelled on a hop: HTTP, HTTPS or SQL, the method or operation, the request and response body kinds, the status and whether it failed; the map draws it as icons |
| Route stats | Calls of an edge broken down by the callee's route, e.g. `GET /api/notes` or `SELECT notes` |
| Span event | Something that happened during a span, e.g. an `exception` or a browser timing mark |
