# Interfaces

Status: design (2026-10-23). Names, ports and defaults below are the plan for the MVP; they become binding when the
code exists. Once the `conventions` crate exists, it is the source of truth for attribute keys, and this file links
to it instead of listing them.

## 1. OTLP ingest (SDKs → collector)

- `POST /v1/traces` on the ingest listener (default `127.0.0.1:4318`, the standard OTLP/HTTP port).
- Content types: `application/x-protobuf` (Rust SDK) and `application/json` (web SDK). Response follows the OTLP
  spec: `200` with partial-success details, `400` malformed, `413` body too large, `503` + `Retry-After` when the
  ingest limit is reached.
- CORS: only for origins listed in `CHEPIO_LENS_CORS_ORIGINS`; allowed method `POST`, allowed header `Content-Type`.
- OTLP/gRPC is not supported in the MVP (ADR-0001).

### Attributes the collector reads

Stable OpenTelemetry semantic conventions; the legacy names in brackets are mapped to stable names at ingest.

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

Rust (axum + sqlx), planned shape:

```rust
let lens = chepio_lens_sdk::init("demo-api")?;   // no-op guard when CHEPIO_LENS_ENDPOINT is unset
let app = Router::new() /* routes */ .layer(lens.http_layer());
// database spans: sqlx query events become client spans (ADR-0008); the app passes its connect options once,
// so the SDK can name the database node
```

Browser:

```ts
initLens({ serviceName: 'demo-web', endpoint: import.meta.env.VITE_CHEPIO_LENS_ENDPOINT,
           propagateTo: [/^http:\/\/localhost:8080\//] })   // no-op when endpoint is empty
```

## 3. UI API (collector → UI)

Served on the UI listener (default `127.0.0.1:4320`) together with the embedded UI. Same origin, so no CORS. JSON
only. Internal contract: the UI and the collector ship in one binary, so no compatibility window is needed.

| Endpoint | Returns |
|---|---|
| `GET /api/graph` | `{ nodes, edges, generated_at }` |
| `GET /api/requests?node=&edge=&status=&limit=&before=` | Request summaries, newest first, cursor by `before` |
| `GET /api/requests/{trace_id}` | The request with all its spans and attributes |
| `GET /api/events` | Server-Sent Events stream, see below |
| `POST /api/reset` | Clears requests and graph; `204` |
| `GET /api/stats` | Collector counters (`runtime.md`, self-observability) |
| `GET /healthz` | `200` when the collector is serving |

SSE events: `node` (node created or changed), `edge` (edge stats changed), `request` (new or updated request summary
with the ordered list of edges it touched, used for animation), `resync` (the client fell behind and must fetch
`/api/graph` again).

Open: how TypeScript types for this API are produced from the Rust types (code generation or a hand-written
schema). Decided together with the first implementation of this API.

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
