# Quality Attributes

Status: design (2026-10-23). Budgets are targets until measured; record measured values in the "Measured" column
with the date and machine.

## Requirements (MVP)

| ID | Requirement |
|---|---|
| F1 | The map shows the instrumented app's frontend, backend services and databases as nodes, discovered from traffic without manual configuration |
| F2 | Edges between them update live; each request is animated along the path it took |
| F3 | Clicking an edge lists its requests; clicking a request shows its timeline (waterfall), headers, bodies, SQL and errors |
| F4 | Connecting a project takes ≤ 15 minutes following the connection guide, and ≤ 10 lines of code per app |
| F5 | Secrets are masked before they leave the instrumented process (`security.md`) |

Non-scope of the MVP: Docker and Kubernetes topology, backends other than Rust (axum + sqlx), persistence across
restarts, production use, authentication.

## Assumptions

- One developer, one local machine (macOS or Linux), the app runs with `docker compose` or natively.
- Up to 10 services, 3 databases, 50 requests/s, 500 spans/s in normal use.
- The developer's browser is a current Chromium, Firefox or Safari.

## Budgets

| Attribute | Target | Measured |
|---|---|---|
| Request end → visible on the map | p95 ≤ 2 s | 0.25 s, one sample (A) |
| Collector ingest throughput | ≥ 2,000 spans/s sustained on a laptop, using < 1 CPU core | 2,000 spans/s at 0.01 cores; maximum ≈ 374,000 spans/s at 1.6 cores, batch p99 6 ms (B) |
| Collector memory at default bounds | RSS ≤ 300 MiB | 60 MiB with the store full by count (10,000 requests of 4 spans, no bodies); 3.4 MiB idle (B). Full by bytes (with bodies) not measured yet |
| Collector startup | ≤ 1 s | 0.56 s to `/healthz` answering (B) |
| Added latency per request in the app (Rust SDK, 16 KiB body capture on) | p95 ≤ 1 ms | — |
| Map rendering | 60 fps with 50 nodes, 100 edges, 200 animated requests | — |
| Collector unavailable | Zero errors and no measurable latency change in the app | — |

Measurement runs (2026-10-24, Apple M1 Pro, 10 cores, 16 GiB, macOS 26.6, release builds, everything on one
machine over loopback):

- (A) `demo/e2e/backend-db.sh`: time from the last demo request to the database edge reaching the expected count.
- (B) Collector started with `cargo build --release -p chepio-lens-collector && target/release/chepio-lens`; load from
  `cargo run --release -p chepio-lens-collector --example ingest_load -- --seconds 20 --workers 4
  --traces-per-batch 50` (maximum) and `-- --seconds 20 --workers 2 --traces-per-batch 25 --rate 2000`. CPU is the
  collector's CPU time divided by wall time; RSS from `ps`.

## Test strategy

| Level | What | Where |
|---|---|---|
| Unit | Graph derivation, linking in any arrival order, legacy-name mapping, redaction, bounds and eviction | `conventions/`, `collector/src/domain/` |
| Shared vectors | The same redaction input/output cases pass in Rust and TypeScript | `conventions/testdata/`, used by `sdk/web` tests |
| Integration | Recorded OTLP fixtures (protobuf and JSON) posted to the ingest handler → expected graph and requests from the UI API; SSE resync | `collector/tests/` |
| SDK | Spans and payload attributes produced for a test axum app and a mocked `fetch`; app unaffected when the endpoint is unreachable | `sdk/rust/tests/`, `sdk/web` |
| UI | Layout, event application, selection; renderer logic separated from canvas calls so it is testable | `ui/` (Vitest) |
| End-to-end | Demo app + collector in compose; a script or Playwright drives the demo; assertions on `/api/graph` and the UI | `demo/` |
| Security | Demo login secrets never reach the collector unmasked; an HTML/JS payload in a body renders as text | e2e + collector tests |

## Performance validation

- Ingest: a load generator replays recorded OTLP batches; measure spans/s, p99 handler time, RSS.
- SDK overhead: compare demo API latency with SDK off, on without bodies, on with bodies, under the same load.
- UI: browser performance profile with a synthetic event stream at the target graph size.
- Each measurement is recorded in the table above with date, machine and command.
