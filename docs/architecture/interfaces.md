# Interfaces

Status (2026-10-24): the collector side of sections 1, 3 and 4 and the Rust SDK without payload capture are
implemented; the web SDK is still the plan.
Attribute keys, the legacy-to-stable mapping and the redaction rules are defined in the `conventions` crate
(`conventions/src/keys.rs`, `legacy.rs`, `redaction.rs`); this file gives their meaning.

## 1. OTLP ingest (SDKs → collector)

- `POST /v1/traces` on the ingest listener (default `127.0.0.1:4318`, the standard OTLP/HTTP port).
- Content types: `application/x-protobuf` (Rust SDK) and `application/json` (web SDK); anything else gets `415`.
  No `Content-Encoding` support: exporters must send uncompressed bodies (the Rust and JS exporters' default).
  Response follows the OTLP spec: `200` with partial-success details (spans with invalid ids or over the per-request
  bound), `400` malformed, `408` body slower than 10 s, `413` body too large, `503` + `Retry-After: 1` when the
  ingest concurrency bound is reached.
- CORS: only for origins listed in `CHEPIO_LENS_CORS_ORIGINS`; allowed method `POST`, allowed header `Content-Type`.
- OTLP/gRPC is not supported in the MVP (ADR-0001).

### Attributes the collector reads

Stable OpenTelemetry semantic conventions; the legacy names in brackets are mapped to stable names at ingest, once
(I8); a stable name present in the same span wins. Exact keys: `conventions/src/keys.rs`, mapping:
`conventions/src/legacy.rs`.

| Purpose | Attributes |
|---|---|
| Node identity | resource `service.name`, resource `telemetry.sdk.language` (`webjs` = browser) |
| HTTP | `http.request.method` (`http.method`), `url.full` (`http.url`), `url.path` + `url.query` (`http.target`), `http.route`, `http.response.status_code` (`http.status_code`), `server.address` + `server.port` (`net.peer.name` + `net.peer.port`), `http.request.header.<name>`, `http.response.header.<name>`, `http.request.body.size`, `http.response.body.size` |
| Database | `db.system.name` (`db.system`), `db.namespace` (`db.name`), `db.query.text` (`db.statement`), `db.operation.name`, `db.collection.name`, `server.address`, `server.port` |
| Errors | span status, `error.type`, `exception` span events |

### `lens.*` attributes (chepio-lens extension)

| Attribute | Type | Set by | Meaning |
|---|---|---|---|
| `lens.http.request.body` | string | SDK | Request body, redacted, cut to the body limit |
| `lens.http.response.body` | string | SDK | Response body, redacted, cut to the body limit |
| `lens.http.request.body.truncated`, `lens.http.response.body.truncated` | bool | SDK | The body was cut |
| `lens.db.query.parameters` | string[] | Rust SDK | SQL parameter values; only when `CHEPIO_LENS_CAPTURE_SQL_PARAMS=true`. Not produced while ADR-0008 holds: sqlx events carry no parameters |
| `lens.redaction.count` | int | SDK, collector | Number of values masked on this span |
| resource `lens.node.kind` | string | SDK (optional) | Overrides node kind: `frontend` or `service` |
| resource `lens.sdk.version` | string | SDK | chepio-lens SDK version |

The collector ignores unknown `lens.*` attributes, so an older collector accepts spans from a newer SDK.

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
- Database spans: from sqlx query events (ADR-0008): `db.system.name`, `server.address`, `server.port`,
  `db.namespace`, `db.query.text`, `db.operation.name`, `db.response.returned_rows`. Without `with_database` the
  system is `other_sql`. Database spans need `sqlx::query` events at `DEBUG` to reach the SDK's tracing layer; the
  first request prints one warning to stderr when they do not.
- Resource: `service.name`, `lens.sdk.version`, and OpenTelemetry's `telemetry.sdk.*`.

Browser:

```ts
initLens({ serviceName: 'demo-web', endpoint: import.meta.env.VITE_CHEPIO_LENS_ENDPOINT,
           propagateTo: [/^http:\/\/localhost:8080\//] })   // no-op when endpoint is empty
```

## 3. UI API (collector → UI)

Served on the UI listener (default `127.0.0.1:4320`) together with the embedded UI (`ui/dist`: embedded in release
builds, read from disk in debug builds; without a build, `/` answers 404 with how to build it). Same origin, so no
CORS. JSON only. Internal contract: the UI and the collector ship in one binary, so no compatibility window is needed.

| Endpoint | Returns |
|---|---|
| `GET /api/graph` | `{ nodes, edges, generated_at }` |
| `GET /api/requests?node=&edge=&status=&limit=&before=` | Request summaries, newest first, cursor by `before` (not built yet) |
| `GET /api/requests/{trace_id}` | The request with all its spans and attributes (not built yet) |
| `GET /api/events` | Server-Sent Events stream, see below |
| `POST /api/reset` | Clears requests and graph; `204` |
| `GET /api/stats` | Collector counters (`runtime.md`, self-observability) |
| `GET /healthz` | `200` when the collector is serving |

SSE events: `node` (node created or changed), `edge` (edge stats changed), `request` (new or updated request summary
with the ordered list of edges it touched, used for animation), `resync` (the client fell behind and must fetch
`/api/graph` again).

JSON shapes: `collector/src/types/api.rs`; the UI uses the TypeScript generated from them in `ui/src/api/generated/`
(ADR-0009).

## 4. Configuration

| Variable | Read by | Default | Meaning |
|---|---|---|---|
| `CHEPIO_LENS_ENDPOINT` | Rust SDK | unset (SDK off) | Collector OTLP base URL, e.g. `http://localhost:4318` |
| `VITE_CHEPIO_LENS_ENDPOINT` (or the app's own env) | web SDK via app config | unset (SDK off) | Same, for the browser |
| `CHEPIO_LENS_CAPTURE_BODIES` | both SDKs | `true` | Capture request and response bodies |
| `CHEPIO_LENS_BODY_LIMIT` | both SDKs | `16384` bytes | Max captured bytes per body |
| `CHEPIO_LENS_CAPTURE_SQL_PARAMS` | Rust SDK | `false` | Capture SQL parameter values |
| `CHEPIO_LENS_REDACT_KEYS` | SDKs, collector | empty | Extra keys to mask, comma-separated; added to the defaults in `security.md` |
| `CHEPIO_LENS_OTLP_ADDR` | collector | `127.0.0.1:4318` | Ingest listener |
| `CHEPIO_LENS_UI_ADDR` | collector | `127.0.0.1:4320` | UI and UI API listener |
| `CHEPIO_LENS_CORS_ORIGINS` | collector | `http://localhost:5173` | Browser origins allowed to send spans |
