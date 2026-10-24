# Collector test fixtures

| File | Format | Source |
|---|---|---|
| `demo_trace.json` | OTLP/JSON | Hand-written per the OTLP/JSON spec: browser → `demo-api` → Postgres, plus an unanswered external call |
| `legacy_names.json` | OTLP/JSON | Hand-written: legacy semantic convention names, a string port, an invalid trace id |
| `rust_sdk_notes.pb` | OTLP/protobuf | Recorded 2026-10-24 from `chepio-lens-sdk` 0.0.0 (opentelemetry-otlp 0.33.1): `GET /api/notes` on the demo API with feature `lens` |
| `rust_sdk_fail.pb` | OTLP/protobuf | Recorded the same way: `GET /api/fail` (500 after a failing query) |

To record again: run a server that saves `POST /v1/traces` bodies, start the demo API with `--features lens` and
`CHEPIO_LENS_ENDPOINT` pointing at it, and send the request. Fixtures contain only demo data and no secrets.
