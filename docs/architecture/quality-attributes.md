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
| Request end → visible on the map | p95 ≤ 2 s | Backend → database: 0.25 s, one sample (A). Browser click → whole chain on the map: 0.92–0.94 s, three runs (C) |
| Collector ingest throughput | ≥ 2,000 spans/s sustained on a laptop, using < 1 CPU core | 2,000 spans/s at 0.01 cores; maximum ≈ 374,000 spans/s at 1.6 cores, batch p99 6 ms (B) |
| Collector memory at default bounds | RSS ≤ 300 MiB | 60 MiB with the store full by count (10,000 requests of 4 spans, no bodies); 3.4 MiB idle (B). Full by bytes (with bodies) not measured yet |
| Collector startup | ≤ 1 s | 0.56 s to `/healthz` answering (B) |
| Added latency per request in the app (Rust SDK, 16 KiB body capture on) | p95 ≤ 1 ms | — |
| Map rendering | 60 fps with 50 nodes, 100 edges, 200 animated requests | 60 fps: 600 frames in 10 s, none late; draw p50/p95/max 0.6 / 0.8 / 1.0 ms at device pixel ratio 1, 0.6 / 0.7 / 0.8 ms at 2 (JavaScript side; rasterization is not included) (D) |
| Collector unavailable | Zero errors and no measurable latency change in the app | — |

Measurement runs (2026-10-24, Apple M1 Pro, 10 cores, 16 GiB, macOS 26.6, release builds, everything on one
machine over loopback):

- (A) `demo/e2e/backend-db.sh`: time from the last demo request to the database edge reaching the expected count.
- (B) Collector started with `cargo build --release -p chepio-lens-collector && target/release/chepio-lens`; load from
  `cargo run --release -p chepio-lens-collector --example ingest_load -- --seconds 20 --workers 4
  --traces-per-batch 50` (maximum) and `-- --seconds 20 --workers 2 --traces-per-batch 25 --rate 2000`. CPU is the
  collector's CPU time divided by wall time; RSS from `ps`.

Measurement runs (2026-10-25, same machine, demo stack in Docker Desktop, Chromium 156 headless from Playwright 1.64):

- (C) `pnpm --filter demo-e2e e2e` (`demo/e2e/tests/frontend-chain.spec.ts`): time from the click on "Add" to the map's
  text summary showing both edges; the browser's batch includes the fetch instrumentation's 300 ms wait.
- (D) `pnpm --filter demo-e2e perf` (`ui/perf.html`, `demo/e2e/perf/map-frames.spec.ts`): synthetic graph of 50 nodes
  and 100 edges, 10 new requests every 100 ms with 2 s on screen (200 at once), 10 s after a 2 s warm-up, viewport
  1440 × 900. Draw time wraps the renderer's draw call; frame intervals come from `requestAnimationFrame`.

Timing diagnosis (2026-10-25, same local demo stack and Chromium): individual requests were matched by a unique
query tag through `/api/logs` to their frontend spans. Browser request timing versus caller-span duration was
67.9 / 69 ms (`/api/fail`), 14.3 / 15 ms (`/api/notes`), 749.7 / 751 ms (`/api/slow`), and 41.9 / 43 ms
(`/api/notes`). The former map label stayed at session p95 741.4552 ms after faster calls: it was an approximate
histogram percentile, not those calls' duration. The map now shows the exact latest caller-span duration; no SDK
timing change was needed. The fetch instrumentation's observer wait delays export, but preserves the end timestamp
captured when the response body completed. This comparison diagnoses display semantics; it is not an SDK overhead
measurement.

## Test strategy

| Level | What | Where |
|---|---|---|
| Unit | Graph derivation, linking in any arrival order, legacy-name mapping, redaction, bounds and eviction | `conventions/`, `collector/src/domain/` |
| Shared vectors | The same redaction input/output cases pass in Rust and TypeScript | `conventions/testdata/`, used by `sdk/web` tests |
| Integration | Recorded OTLP fixtures (protobuf and JSON) posted to the ingest handler → expected graph and requests from the UI API; SSE resync | `collector/tests/` |
| SDK | Spans and payload attributes produced for a test axum app and a mocked `fetch`; app unaffected when the endpoint is unreachable | `sdk/rust/tests/`, `sdk/web` |
| UI | Layout, event application, selection; renderer logic separated from canvas calls so it is testable | `ui/` (Vitest) |
| End-to-end | Demo app + collector in compose: a script drives the API and checks `/api/graph`; Playwright clicks in the demo and checks the map's text summary and that the request is animated once | `demo/e2e/` |
| Security | Demo login secrets never reach the collector unmasked; an HTML/JS payload in a body renders as text | e2e + collector tests |

## Performance validation

- Ingest: a load generator replays recorded OTLP batches; measure spans/s, p99 handler time, RSS.
- SDK overhead: compare demo API latency with SDK off, on without bodies, on with bodies, under the same load.
- UI: browser performance profile with a synthetic event stream at the target graph size.
- Each measurement is recorded in the table above with date, machine and command.
