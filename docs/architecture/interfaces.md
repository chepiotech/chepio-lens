# Interfaces

Status (2026-10-25): traces, app logs and browser actions reach the collector, logs panel and request inspector.
Both SDKs capture headers, bodies and structured application logs.
Attribute keys, the legacy-to-stable mapping and the redaction rules are defined in the `conventions` crate
(`conventions/src/keys.rs`, `legacy.rs`, `redaction.rs`); this file gives their meaning.

## 1. OTLP ingest (SDKs → collector)

- `POST /v1/traces` and `POST /v1/logs` on the ingest listener (default `127.0.0.1:4318`, the standard OTLP/HTTP port).
- Content types: `application/x-protobuf` (Rust SDK) and `application/json` (web SDK); anything else gets `415`.
  No `Content-Encoding` support: exporters must send uncompressed bodies (the Rust and JS exporters' default).
  Response follows the OTLP spec: `200` with partial-success details (spans with invalid ids or over the per-request
  bound; logs with invalid context or severity), `400` malformed, `408` body slower than 10 s, `413` body too large, `503` + `Retry-After: 1` when the
  ingest concurrency bound is reached.
- CORS: only for origins listed in `CHEPIO_LENS_CORS_ORIGINS`. Preflights from those origins get `200` with allowed
  method `POST`, allowed header `Content-Type`, `Access-Control-Max-Age: 600`; every response to them carries
  `Access-Control-Allow-Origin` and exposes `Retry-After`. A preflight or export with any other `Origin` (including
  `null`) gets `403`. Requests without `Origin` (backend SDKs, curl) are not affected.
- OTLP/gRPC is not supported in the MVP (ADR-0001).

Log exports use OTLP `ExportLogsServiceRequest/Response`. Trace and span ids are optional: empty or correctly
sized all-zero ids mean absent; a span id without a valid trace id is rejected. Missing time uses observed time,
then collector arrival time. Severity numbers 1–24 map to trace/debug/info/warn/error/fatal in groups of four;
zero uses recognized severity text, otherwise the level is absent. Numbers outside 0–24 are rejected. Log resources
create service nodes but never requests or edges. Log attributes normalize like span attributes; structured maps
and arrays retain their keys through redaction. Retention and per-record limits are in `runtime.md`.

### Attributes the collector reads

OpenTelemetry semantic conventions (RPC uses the 1.44.0 release candidate, ADR-0015); legacy names in brackets are
mapped to current names at ingest, once (I8); a current name present in the same span wins. Exact keys: `conventions/src/keys.rs`, mapping:
`conventions/src/legacy.rs`.

| Purpose | Attributes |
|---|---|
| Node identity | resource `service.name`, resource `telemetry.sdk.language` (`webjs` = browser) |
| HTTP | `http.request.method` (`http.method`), `url.full` (`http.url`), `url.path` + `url.query` (`http.target`), `http.route`, `http.response.status_code` (`http.status_code`), `server.address` + `server.port` (`net.peer.name` + `net.peer.port`), `http.request.header.<name>`, `http.response.header.<name>`, `http.request.body.size`, `http.response.body.size` |
| gRPC | `rpc.system.name = grpc` (`rpc.system`), qualified `rpc.method` (legacy `rpc.service` + `/` + `rpc.method`), `rpc.method_original`, string `rpc.response.status_code` (legacy numeric `rpc.grpc.status_code` mapped to its name), `server.address`, `server.port` |
| Database | `db.system.name` (`db.system`), `db.namespace` (`db.name`), `db.query.text` (`db.statement`), `db.operation.name`, `db.collection.name`, `server.address`, `server.port` |
| Errors | span status, `error.type`, `exception` span events |

### `lens.*` attributes (chepio-lens extension)

| Attribute | Type | Set by | Meaning |
|---|---|---|---|
| `lens.http.request.body` | string | SDK | Request body, redacted, cut to the body limit |
| `lens.http.response.body` | string | SDK | Response body, redacted, cut to the body limit |
| `lens.http.request.body.truncated`, `lens.http.response.body.truncated` | bool | SDK | The body was cut |
| `lens.redaction.count` | int | SDK, collector | Number of values masked on this span or log record |
| `lens.log.kind` | string | web SDK | `action` for clicks, submits and navigation; other values mean an ordinary log |
| `lens.action.id` | string | web SDK | 16 hex characters per user action, on its action record and on every fetch span its handler starts synchronously; a navigation inside the handler shares it (ADR-0016) |
| `lens.db.affected_rows` | int | Rust SDK | Rows the statement affected, as the driver reports them; Postgres counts a `SELECT`'s rows too |
| `lens.log.truncated` | bool | both SDKs | Some log content was omitted or shortened |
| resource `lens.node.kind` | string | SDK (optional) | Overrides node kind: `frontend` or `service` |
| resource `lens.node.metadata` | JSON string | both SDKs (optional) | Declared technology stack, page paths and microfrontends for the map card; shape and limits below |
| resource `lens.sdk.version` | string | SDK | chepio-lens SDK version |

The collector ignores unknown `lens.*` attributes, so an older collector accepts spans from a newer SDK.

### Declared node metadata

`lens.node.metadata` is optional on trace and log resources. It is an object with `technologies: string[]`,
`pages: string[]` and `microfrontends: { name: string, framework: string, pages: string[] }[]`; missing lists become
empty. Both SDKs normalize settings once during initialization and share the resource between traces and logs.
The collector normalizes again before storing metadata, once per resource batch. This declares the application's
stack; it does not inspect dependencies or discover routers.

Normalization is defined in `conventions/src/node_metadata.rs` and checked against the web implementation with
`conventions/testdata/node_metadata.json`. Limits: 16 technologies (48 UTF-8 bytes each), 8 microfrontends (64 bytes
per name), and 32 page paths in total across the shell and all microfrontends (160 bytes each). Limits apply to
input prefixes; invalid entries and duplicates are omitted. Technology identifiers use lowercase ASCII letters,
digits, spaces and `. + # _ -`; `reactjs`, `vuejs`, `next.js`, `nuxtjs` normalize to `react`, `vue`, `nextjs`, `nuxt`.
Frontend framework identifiers are `react`, `vue`, `angular`, `svelte`, `solid`, `preact`, `nextjs`, `nuxt`, `qwik`.
Backend technologies may use any valid identifier. Page paths start with `/` but not `//`; query strings and
fragments are removed. Use static labels and route templates, never credentials or user-specific page content.

Malformed, non-object or over-16-KiB wire metadata is ignored without rejecting telemetry. The latest valid report
received for a service replaces its metadata and emits an SSE `node` update. Missing/invalid reports preserve
existing metadata; `{}` explicitly clears it. Services sharing a name should declare the same metadata. Old SDKs
remain usable and show an unreported stack. Redis uses ordinary database client spans with `db.system.name=redis`;
the UI presents that database node as a cache. Declaring `redis` in a backend's stack alone does not invent a node
or an edge.

## 2. SDK public API

The SDK APIs are public and versioned with semver: breaking changes need a major version.

Rust (axum + sqlx), `sdk/rust`:

```rust
let lens = chepio_lens_sdk::init("demo-api")?          // no-op unless CHEPIO_LENS_ENDPOINT is set
    .with_database(chepio_lens_sdk::Database::postgres_url(&database_url)); // host, port, name; no credentials
lens.install_tracing()?;                               // or add lens.tracing_layer() to the app's own subscriber
let app = Router::new() /* routes */ .layer(lens.http_layer());
// after serving: lens.shutdown();                      // flushes, waits at most 2 s
```

- Server spans: one per request, joined to the caller via `traceparent`; name `<method> <route>`; attributes
  `http.request.method`, `url.path`, `url.query`, `http.route`, `http.response.status_code`; status error for 5xx.
- Outbound: `lens.client_layer().layer(client)` wraps a hyper client or tonic channel (`tower::Layer`). It propagates
  `traceparent` from a new client span under the current context. Readiness and transport errors are unchanged;
  requests keep their concrete body type. HTTP attributes include method, path, redacted query, scheme, server
  address/port and response status; HTTP 4xx/5xx mark client spans as errors. Request headers and declared size are
  captured, but client request bodies are not; the instrumented callee captures them. Response bodies use the same
  capture limits as server spans. `ObservedBody<B>` preserves the underlying response frames and error type.
  `.with_endpoint(uri)` supplies a channel's endpoint when its request has no authority; only host/port/scheme are
  recorded, and the request destination is never changed.
- Native gRPC: `http_layer()` on `tonic::transport::Server::builder()` and `client_layer()` on the channel detect
  `application/grpc` or `application/grpc+…`. RPC status is read from response headers or final trailers; HTTP 200
  alone is not success. Client non-OK statuses are errors; server errors are UNKNOWN, DEADLINE_EXCEEDED,
  UNIMPLEMENTED, INTERNAL, UNAVAILABLE and DATA_LOSS. Missing/invalid status, body errors and cancellation are
  failures. Error categories are status names or fixed `grpc.missing_status`, `grpc.invalid_status`, `body.error`,
  `transport.error`, `service.error`, `http.status_error`, `cancelled`; transport messages are never exported.
  Both layers accept `.with_rpc_methods(&["package.Service/Call"])` with a static list. Other methods use `_OTHER`
  and a valid bounded path in `rpc.method_original` (at most 512 bytes); span name is the known method or `grpc`.
  Payloads and arbitrary metadata are omitted, including `grpc-message` and `grpc-status-details-bin`. Streaming
  spans stay open through trailers/body completion and restore their context while polling. gRPC-Web is not covered.
- Headers and bodies: every request and response header as `http.request.header.<name>` /
  `http.response.header.<name>` (string array, sensitive names masked); bodies of text content types as
  `lens.http.request.body` / `lens.http.response.body` with `lens.http.*.body.truncated` and `http.*.body.size`, by
  the rules in `security.md` (Body capture). The SDK copies the bodies while they stream through; the app reads them
  unchanged. The server span ends when the response body has been sent or dropped, so its duration includes the body.
  `url.query` is masked. Configuration: `CHEPIO_LENS_CAPTURE_BODIES`, `CHEPIO_LENS_BODY_LIMIT`,
  `CHEPIO_LENS_REDACT_KEYS` (section 4); an invalid value prints a warning and keeps the default.
- Database spans: from sqlx query events (ADR-0008): `db.system.name`, `server.address`, `server.port`,
  `db.namespace`, `db.query.text`, `db.operation.name`, `db.response.returned_rows`, `lens.db.affected_rows`; no
  parameter values or row contents (ADR-0010, ADR-0016).
  Without `with_database` the system is `other_sql`. Database spans need `sqlx::query` events at `DEBUG` to reach the SDK's tracing layer; the
  first request prints one warning to stderr when they do not.
- Application logs: `tracing` events reaching `lens.tracing_layer()` become OTLP logs with severity, target, fields
  and the current OTel context. `sqlx::query` still becomes a query span only. The application's subscriber controls
  levels; the subscriber that `install_tracing()` sets exports `INFO` and above and lets `sqlx::query` through at
  `DEBUG` for database spans, so libraries' `DEBUG`/`TRACE` events (such as axum's line per accepted connection) stay
  out (`sdk/rust/tests/install_tracing_levels.rs`). Telemetry-internal events and HTTP transport targets (`hyper`, `hyper_util`, `h2`, `reqwest`) are excluded
  from this export layer to prevent export loops; other subscriber layers remain unchanged. Transport exclusions
  also apply to those libraries when used by the app. Without an active context a log remains uncorrelated.
- Resource: `service.name`, `lens.sdk.version`, optional `lens.node.metadata`, and OpenTelemetry's `telemetry.sdk.*`.
- Map card settings can come from `CHEPIO_LENS_NODE_METADATA` or typed `Config.node`. For example:

```rust
let mut config = chepio_lens_sdk::Config::from_env("demo-api", |key| std::env::var(key).ok());
config.node = Some(chepio_lens_sdk::NodeMetadata {
    technologies: vec!["rust".into(), "axum".into(), "sqlx".into(), "tokio".into()],
    ..Default::default()
});
let lens = chepio_lens_sdk::init_with(config)?;
```

Browser:

```ts
import { initLens } from 'chepio-lens-web'

const lens = initLens({
  serviceName: 'demo-web',
  endpoint: import.meta.env.VITE_CHEPIO_LENS_ENDPOINT, // no-op when empty or missing
  propagateTo: [/^http:\/\/localhost:8080\//],         // cross-origin targets that get traceparent
  redactKeys: ['tenant'],                               // optional, added to the defaults
  captureBodies: true,                                  // optional; headers are always captured
  bodyLimit: 16_384,                                    // optional, bytes of a masked body
  node: {                                              // optional, static map-card metadata
    technologies: ['react'],
    pages: ['/'],                                       // shell pages
    microfrontends: [
      { name: 'Notes', framework: 'react', pages: ['/notes', '/notes/:id'] },
      { name: 'Workspace', framework: 'vue', pages: ['/settings'] },
    ],
  },
})
// await lens.shutdown()                                 // stops tracing, flushes, waits at most 2 s, never rejects
```

- Client spans: one per `fetch` call (OpenTelemetry fetch instrumentation); name `<method>`; attributes
  `http.request.method`, `url.full`, `server.address`, `server.port`, `http.response.status_code`; status error for
  4xx and 5xx. Same-origin requests always get `traceparent`, cross-origin ones only when they match `propagateTo`
  (the target must allow the header in its CORS policy).
- `url.full` has its query parameters masked before export (`lens.redaction.count` on the span).
- Headers and bodies by the rules in `security.md` (Body capture), with the same attributes as the Rust SDK. Request
  bodies are read only when the app passes a string or `URLSearchParams`, or a `Request` (from a clone); response
  bodies from a clone taken before the app receives the response (an outer `fetch` wrapper around the
  instrumentation, which hands its span over through `requestHook`). The app's own request and response are not
  touched. A body still being read when the span ends (300 ms after the response completes) is left out.
- Console: `debug`, `info`, `log`, `warn`, `error` become logs; `log` maps to info. Original console methods still
  receive the original arguments. Structured arguments are serialized with key masking and fixed limits; getters
  and custom serializers are not invoked. OpenTelemetry diagnostics and export traffic are excluded.
- Actions: clicks, submits and history/popstate/hashchange navigation become info logs stamped with the event's own
  time in whole milliseconds (like the browser's span starts), each with a `lens.action.id`. A submit caused by a
  click on its submit button, or requested from a click handler, belongs to that click: one record. A control
  (button, link, `role=button`, form) is named by its accessible name or button/link text; any other element, or a
  control without a name, by a description built from attributes only: tag, id, two classes, `role`, `data-testid`,
  `name` and position among siblings of the same tag, for the element and its ancestors up to the nearest one with an
  id, test id or role (five levels; without one, the two nearest), e.g.
  `click span in li (3 of 12) in ul in section in div#notes`. Never input values or page text; navigation captures
  only the pathname. Initialize before registering application handlers. Every fetch started synchronously by an
  event handler gets the action's id, and so does a navigation inside it; the first fetch also supplies its actual
  trace/span ids to the action record. Handlers after `await`, timers, pre-existing handlers and inline handlers have
  no promised correlation; the SDK never guesses a link from temporal proximity (ADR-0012, ADR-0016). It creates no
  action spans.
- Shutdown restores console and history methods and stops action capture. A single pass-through event-listener
  wrapper remains to preserve listener identity for removal and duplicate registration after shutdown/reinit.
- Export: OTLP/HTTP JSON to `<endpoint>/v1/traces` and `<endpoint>/v1/logs` with `fetch` (`keepalive`, CORS mode, no credentials), batch every
  500 ms, separate queues of 2,048 spans and 2,048 logs, timeout 2 s; export requests are not traced. An endpoint that is not a URL prints one
  console warning and leaves the SDK off; `initLens` never throws. A second call while running returns the running
  instance.
- Resource: `service.name`, `lens.sdk.version`, optional `lens.node.metadata`, and OpenTelemetry's `telemetry.sdk.*` (`telemetry.sdk.language =
  webjs`, so the collector draws a frontend node).

## 3. UI API (collector → UI)

Served on the UI listener (default `127.0.0.1:4320`) together with the embedded UI (`ui/dist`: embedded in release
builds, read from disk in debug builds; without a build, `/` answers 404 with how to build it). Same origin, so no
CORS. JSON only. Internal contract: the UI and the collector ship in one binary, so no compatibility window is needed.

| Endpoint | Returns |
|---|---|
| `GET /api/graph` | `{ nodes, edges, generated_at }` |
| `GET /api/logs?layer=&node=&edge=&status=&level=&kind=&q=&limit=&before=` | Log lines, newest first: `{ entries, next_before }`. `layer`: comma-separated `frontend`, `backend`, `database` (empty = all); `node`: a node id; `edge`: an edge id (lines of the client spans of its hops and of the server spans they called within the same trace, for requests still in memory); `status`: `ok` or `error` (error/fatal for log records); `level`: comma-separated trace/debug/info/warn/error/fatal (span lines have no level); `kind`: comma-separated log/action/request/query/call/span; `q`: case-insensitive substring of the line text, service or trace id; `limit`: default 100, at most 500; `before`: an entry `id` for the next, older page. Unknown values give `400` |
| `GET /api/activities?layer=&node=&edge=&status=&origin=&q=&limit=&before=` | Activities, newest first: `{ activities, next_before }` (ADR-0016). Filters as for `/api/logs`; an activity matches when any of its lines does. `origin`: comma-separated `action`, `request`; `before`: an activity's `cursor`; `limit`: default 50, at most 200. Unknown values give `400` |
| `GET /api/activities/{id}` | `{ activity, steps, truncated_steps }` for `action:<id>` or `trace:<trace id>`. `400` for a malformed id, `404` once dropped or reset |
| `GET /api/requests/{trace_id}` | The request summary and every span: ids, parent, service, layer, kind, name, start offset from the request's earliest span as received (I12), duration, status and message, attributes (`{key, kind, values}`; arrays as one value per item), events (name, offset from the span's start, attributes, `truncated_attributes`), truncated span keys. `400` for a malformed id, `404` once evicted or reset |
| `GET /api/events` | Server-Sent Events stream, see below |
| `POST /api/reset` | Clears requests, logs and graph; `204` |
| `GET /api/stats` | Collector counters (`runtime.md`, self-observability) |
| `GET /healthz` | `200` when the collector is serving |

SSE events: `node` (node created or changed), `edge` (edge stats changed, with `routes`: calls per route of the
callee, most called first), `request` (new or updated request summary with `has_root` and `hops`: each edge it
touched with its start offset and duration on the request's timeline, used for animation), `log` (a new log line,
one per stored span or app/action record, the same shape as an entry of `GET /api/logs`), `activity` (a new or changed
activity, `{ activity, replaces }`: drop the rows named in `replaces`, they were merged into this one), `resync` (the client fell behind and must fetch
`/api/graph` again).

Snapshot nodes and SSE `node` events include optional `metadata: { technologies, pages, microfrontends }`, using
the normalized shape above. It is omitted when no metadata was reported, including infrastructure nodes. The UI
combines declared pages with navigation observed while the map is open; endpoints come from incoming edge routes.

Each hop has a `packet` for the map's packet icons, or `null` when its caller span is no longer stored:
`kind` (`http`, `https`, `sql`, `grpc`), `operation` (HTTP method or SQL operation in upper case; qualified gRPC method,
at most 512 bytes; `null` when unknown), `request_body` and `response_body` (`none`, `json`, `form`, `text`, `binary`),
`status_code`, `rpc_status` and `error`. gRPC packets use binary body kinds without capturing content, a named
`rpc_status` from the fixed protocol status set, and no HTTP `status_code`; non-gRPC packets have `rpc_status: null`.
The collector takes each value from the hop's caller span and falls back to the callee's server span: the scheme
from `url.scheme` or `url.full`; body kinds from the `content-type` header attributes (`+json` counts as JSON,
`multipart/form-data` as form, `text/*` as text, other types with bytes as binary), and size `0` means no body; the
SQL operation from `db.operation.name`, else the first word of `db.query.text`. `error` follows the edge rule (caller
or callee failed). SQL packets have no body kinds or status. The UI draws the request icon out, waits at the callee
and draws the response icon back; log records and user actions from SSE `log` flash at their `nodes`.

Activity steps (ADR-0016, I13) come in call-tree order: the action, then each fetch's tree depth first. A span gives a
start and an end step: `send`/`response` for a client call, `receive`/`respond` for a server span, `query`/`result`
for a database query, `span` for anything else; app log lines with a span's context sit inside it as `log` steps, and
calls into another process come right after the caller's start. Each step has its service, node (the database's for
`query` and `result`), trace and span ids, time and `offset_ms` from the activity's time as received (negative across
skewed clocks, I12), the duration on end steps, a one-line `text`, status code, error flag, level and `details`:
labelled values already redacted, rendered as text (I11): URL, request or response headers and body, SQL text, rows
returned and affected, error message, record attributes. No row contents (ADR-0010).

Log entries have nullable `trace_id`, `span_id`, `level`, `duration_ms` and `record`. For app/action logs, duration
is absent and `record` contains `body` (redacted text), typed `attributes` and `truncated`; span lines have no record.
The inspector shows uncorrelated logs directly. Correlated logs can open their retained request; a missing request
does not hide the log. Edge filters include logs with the actual client or server span context, including records
received before those spans. Text search covers the stored redacted message, service and trace id.

JSON shapes: `collector/src/types/api.rs`; the UI uses the TypeScript generated from them in `ui/src/api/generated/`
(ADR-0009).

Edges in snapshots and SSE include `last_error` and `last_duration_ms`: the latest completed call's result and
caller-span duration. The map uses these for its arrow color and `Last …` label; a successful call clears the red
arrow. Delayed older calls still contribute to session `count`, `errors`, `p50_ms` and `p95_ms`, but do not replace
the latest result. Percentiles are approximate session statistics, shown separately in edge details. Latest-call
ordering uses the caller's timestamps (`data.md`); clocks of different instances sharing a service name can skew
that ordering. Neither export delay nor animation duration is included in `last_duration_ms`.

## 4. Configuration

| Variable | Read by | Default | Meaning |
|---|---|---|---|
| `CHEPIO_LENS_ENDPOINT` | Rust SDK | unset (SDK off) | Collector OTLP base URL, e.g. `http://localhost:4318` |
| `VITE_CHEPIO_LENS_ENDPOINT` (or the app's own env) | web SDK via app config | unset (SDK off) | Same, for the browser |
| `CHEPIO_LENS_NODE_METADATA` (Rust: `Config.node`; web: `node`) | SDKs | absent | Optional declared node metadata; malformed environment JSON is silently ignored. See Declared node metadata above |
| `CHEPIO_LENS_CAPTURE_BODIES` (web: `captureBodies` option) | both SDKs | `true` | Capture request and response bodies (`true`/`1`, `false`/`0`); headers are always captured |
| `CHEPIO_LENS_BODY_LIMIT` (web: `bodyLimit` option) | both SDKs | `16384` bytes | Max exported bytes per redacted body |
| `CHEPIO_LENS_REDACT_KEYS` | SDKs, collector | empty | Extra keys to mask, comma-separated; added to the defaults in `security.md` |
| `CHEPIO_LENS_OTLP_ADDR` | collector | `127.0.0.1:4318` | Ingest listener |
| `CHEPIO_LENS_UI_ADDR` | collector | `127.0.0.1:4320` | UI and UI API listener |
| `CHEPIO_LENS_CORS_ORIGINS` | collector | `http://localhost:5173,http://127.0.0.1:5173` | Browser origins allowed to send telemetry, comma-separated `scheme://host[:port]`; no wildcard; empty allows none |
