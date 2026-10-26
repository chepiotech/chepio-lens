# Collector test fixtures

| File | Format | Source |
|---|---|---|
| `demo_trace.json` | OTLP/JSON | Hand-written per the OTLP/JSON spec: browser → `demo-api` → Postgres, plus an unanswered external call |
| `legacy_names.json` | OTLP/JSON | Hand-written: legacy semantic convention names, a string port, an invalid trace id |
| `rust_sdk_notes.pb` | OTLP/protobuf | Recorded 2026-10-24 from `chepio-lens-sdk` 0.0.0 (opentelemetry-otlp 0.33.1): `GET /api/notes` on the demo API with feature `lens` |
| `rust_sdk_fail.pb` | OTLP/protobuf | Recorded the same way: `GET /api/fail` (500 after a failing query) |
| `web_sdk_notes.json` | OTLP/JSON | Recorded 2026-10-25 from `chepio-lens-web` 0.0.0 (OpenTelemetry JS 2.12 / 0.223) in Chromium: the demo web loading (two `GET /api/notes`, React StrictMode in dev) and adding a note (`POST /api/notes`); two export batches merged |
| `web_api_notes.pb` | OTLP/protobuf | The demo API's two batches from the same session (Rust SDK), concatenated (protobuf merges repeated fields); its server spans are children of the browser spans above |

To record again: run a server that saves `POST /v1/traces` bodies, start the demo API with `--features lens` and
`CHEPIO_LENS_ENDPOINT` pointing at it, and send the request. For browser batches the server must also answer CORS
preflights from the demo web's origin, and the demo web must call `initLens` with that server as `endpoint`. Fixtures contain only demo data and no secrets.

`grpc_chain.json` is synthetic OTLP/JSON: browser → gateway → gRPC identity → PostgreSQL. The RPC uses current
client and legacy server attributes; both have HTTP 200 and an INTERNAL RPC status, with no explicit span error.
API tests also send a later successful variant and reverse batch order to check recovery and normalization.

`node_metadata.json` is synthetic OTLP/JSON based on `demo_trace.json`, with declared React/Vue microfrontends,
Rust/axum/SQLx technologies, fake page query values and a Redis client span. API tests send JSON and protobuf forms,
check normalized node metadata and the backend → Redis edge, then exercise log-resource metadata updates over SSE.
