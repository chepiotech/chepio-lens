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
| Collector ingest throughput | ≥ 2,000 spans/s sustained on a laptop, using < 1 CPU core | 2,000 spans/s at 0.01 cores; maximum ≈ 374,000 spans/s at 1.6 cores, batch p99 6 ms (B). With the activity index (ADR-0016), on a loaded machine and next to the build without it: maximum 69,000–71,000 spans/s against 83,000–84,000 (−15%), batch p99 23–26 ms against 23–24 ms, RSS 106–114 MiB against 92 MiB with 10,000 requests and 10,000 activities (J) |
| Collector memory at default bounds | RSS ≤ 300 MiB | 60 MiB with the store full by count (10,000 requests of 4 spans, no bodies); 3.4 MiB idle (B). Full by bytes (with bodies) not measured yet |
| Collector startup | ≤ 1 s | 0.56 s to `/healthz` answering (B) |
| Added latency per request in the app (Rust SDK, 16 KiB body capture on) | p95 ≤ 1 ms | Bodies on: +0.13 ms at p95, +0.05 ms at p50 over the whole mix; requests without a database query +0.13–0.17 ms at p95, +0.03 ms at p50. Exporting without bodies +0.28 ms at p95; SDK without an endpoint +0.07 ms (E). With app log export: bodies on +0.24 ms at p95, +0.11 ms at p50; the most is a 100 KB JSON response, +0.47 ms at p50 and +0.98 ms at p95, spent masking the whole body (F) |
| Added latency per fetch in the browser (web SDK, 16 KiB body capture on) | p95 ≤ 1 ms | Bodies on +0.61 ms at p95 and +0.36 ms at p50 with 64-span export batches (I); before, +0.82 / +0.32 ms and +1.34 / +0.46 ms with the machine under heavy load (H). Exporting without bodies +0.34–0.78 ms at p95, +0.25 ms at p50. Main-thread time per request +0.52–0.61 ms with bodies, +0.33–0.43 ms without (0.62–0.67 ms without the SDK); the 100 KB JSON response costs the most, +0.58–0.84 ms at p50 (H) |
| Map rendering | 60 fps with 50 nodes, 100 edges, 200 animated requests | 60 fps: 600 frames in 10 s, none late; draw p50/p95/max 0.6 / 0.8 / 1.0 ms at device pixel ratio 1, 0.6 / 0.7 / 0.8 ms at 2 (JavaScript side; rasterization is not included) (D). With packet icons and node flashes: still 60 fps, none late; draw 1.6 / 1.9 / 2.7 ms at 1, 1.3 / 1.5 / 2.4 ms at 2 (G) |
| Collector unavailable | Zero errors and no measurable latency change in the app | Rust SDK, nothing listening at the endpoint: 0 errors in 20,000 requests; p50 +0.06 ms, p95 −0.13 ms, within the noise (E); with app log export 0 errors in 10,000, p95 +0.15 ms (F). Web SDK, endpoint on a closed port: 0 errors in 10,000 fetches, p95 +0.92 ms, p99 +1.53 ms, p50 +0.26 ms with 64-span export batches, under heavy load (I); with 512-span batches it missed the budget: p95 +1.91–2.18 ms, p99 +9.2–9.8 ms (H) |

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

Measurement run (2026-10-25, same machine, macOS 26.6.2, Docker Desktop 29.5.3, release builds; the machine was busy
with other builds, load average 10 at the start and 47 at the end):

- (E) `cargo run --release -p demo-api --features lens --example sdk_overhead -- --rounds 20`
  (`demo/api/examples/sdk_overhead.rs`, procedure in `demo/README.md`): the demo API in five processes (without the
  SDK; SDK without an endpoint; exporting without bodies; exporting with bodies at the 16 KiB limit; endpoint on a
  closed port), Postgres 17 in Docker, a release collector. 100 requests/s per mode over 4 keep-alive connections,
  an equal mix of `GET /api/health`, `POST /api/login`, `GET` and `PUT /api/notes/{id}` (1000-character note) and
  `GET /api/notes` (about 100 KB, cut to 16 KiB); 20 rounds of 10 s per mode in rotating order, 20,000 requests per
  mode. Each value is the median over the rounds of that round's percentile, and differences are taken within a
  round: single slots stalled the whole machine (one slot without the SDK reached p95 1.5 s). The p95 of requests
  with a database query varies by several milliseconds between slots (Postgres in the Docker Desktop VM), so
  per-request differences there are not resolved below about 1.5 ms: exporting without bodies showed +1.47 ms on
  `GET /api/notes` while exporting with bodies, which does more work, showed −0.05 ms. p99 differences (−0.5 to
  +2 ms) are within the same noise. The collector rejected and dropped no spans.

Measurement run (2026-10-25, same machine, demo stack's Postgres and collector in Docker Desktop, after app log
export; load average 3–5):

- (F) `cargo run --release -p demo-api --features lens --example sdk_overhead -- --collector http://127.0.0.1:4318`:
  as (E) with the defaults, 10 rounds of 10 s per mode, 10,000 requests per mode. The SDK now also exports `tracing`
  events as logs; the subscriber that `install_tracing()` sets passes `INFO` and above. Per-slot stalls were rarer
  (one slot reached p95 72 ms), so per-request differences are resolved better than in (E): without a database
  query +0.04–0.06 ms at p50 and +0.25–0.34 ms at p95; the 100 KB `GET /api/notes` costs +0.47 ms at p50 with
  bodies on and about the same with the collector unreachable, so that cost is redacting the body, not exporting it.

Measurement run (2026-10-25, same machine, Chromium 156 headless from Playwright 1.64, load average 4–5):

- (G) `pnpm --filter demo-e2e perf` as (D), with packet icons: every hop carries a packet, cycling through
  HTTP/HTTPS documents with each body kind, a failed call and SQL queries, so icons, the HTTPS badge and labels are
  all drawn; plus two log or action flashes at nodes every 100 ms (24 on screen at once).

Measurement runs (2026-10-26, same machine, macOS 26.6.2, Chromium 156 headless from Playwright 1.64; Docker Desktop
busy with another session's work: load average 20 falling to 6.7 during H1, 5.7 to 12.7 during H2):

- (H) `pnpm --filter demo-e2e sdk-overhead` (`demo/e2e/sdk-overhead/web-sdk-overhead.spec.ts`, bench page
  `demo/web/sdk-overhead.html`, procedure in `demo/README.md`), run twice with the defaults (H1, H2): the request mix
  of (E), sent with `fetch` from the bench page to a fixed in-process API of its Vite dev server, without a database,
  so the differences come from the browser. 100 requests/s from 4 loops on the schedule of (E); modes without the SDK,
  exporting without bodies, with bodies, endpoint on a closed port; each slot in a fresh browser context, 2 s warm-up
  and 10 s measured, 10 rounds in rotating order, 10,000 requests per mode; statistics as in (E). Latency runs from
  the `fetch` call to the end of `response.json()`; the page is cross-origin isolated, so `performance.now()` resolves
  to 5 µs. Main-thread time is Chromium's `TaskDuration` over the measured part, divided by its requests. The bench's
  own release collector received every span of the exporting slots and rejected, dropped or refused none; one long
  task (over 50 ms) in both runs together. Single slots stalled (p95 up to 34 ms), so only medians of per-round
  differences are used. With bodies on the OpenTelemetry fetch instrumentation and the SDK each read a clone of the
  response, and the SDK masks the whole JSON body on the main thread.
- Profile (Chromium trace and CPU profile of 10 s slots, same load): with the collector unreachable, main-thread tasks
  of 11–20 ms came in pairs about every 2 s (14 over 10 ms, against 3 without the SDK). A failed export holds the
  batch processor for up to its 2 s timeout, so the next batch grows to about 200 spans with bodies (about 1 MB),
  and every retry calls `fetch` again with that body: inside those tasks 29 ms were the exporter's native `fetch`
  call, 33 ms native code and 18 ms serialization. With the collector up, the batch leaves every 500 ms, a quarter
  the size and without retries (5–8 ms tasks).
- (I) As (H), once, after the fix: web SDK export batches of 64 spans instead of 512 (and 33 concurrent exports, so
  shutdown can still flush a full queue). Load average 18 falling to 12.6.

Measurement run (2026-10-26, same machine, release builds, load average 16–20 from other work):

- (J) `cargo run --release -p chepio-lens-collector --example ingest_load -- --target 127.0.0.1:34318 --seconds 15
  --workers 4 --traces-per-batch 50` against two collectors in turn on the same ports, twice each: `main` before the
  activity index and the branch adding it. Only the comparison counts; absolute values are lower than (B) because of
  the load. Removing two allocations per span in the index (service and node ids) took the cost from −35% to −15%.

## Test strategy

TaskHub shared-renderer regression check (2026-10-26, same machine, Chromium, 1440 × 900):
`pnpm --filter demo-e2e perf` passes at device pixel ratios 1 and 2 after adding optional declared scenes.
The existing 50-node/100-edge/200-request fixture remains below its 16.67 ms p95 JavaScript draw budget in
both runs. This verifies the live renderer's regression threshold; it does not measure TaskHub service latency.

| Level | What | Where |
|---|---|---|
| Unit | Graph derivation, linking in any arrival order, legacy-name mapping, redaction, bounds and eviction | `conventions/`, `collector/src/domain/` |
| Shared vectors | The same redaction and declared-node-metadata input/output cases pass in Rust and TypeScript | `conventions/testdata/`, used by `sdk/web` tests |
| Integration | Recorded OTLP fixtures (protobuf and JSON) posted to the ingest handler → expected graph and requests from the UI API; SSE resync | `collector/tests/` |
| SDK | Spans and payload attributes produced for a test axum app and a mocked `fetch`; app unaffected when the endpoint is unreachable | `sdk/rust/tests/`, `sdk/web` |
| UI | Layout, event application, selection; renderer logic separated from canvas calls so it is testable | `ui/` (Vitest) |
| Map cards | Built UI under the collector CSP at desktop/mobile widths; technology assets, microfrontends, Redis, controls, legacy snapshots, metadata events and isolated TaskHub scenarios/boundaries | `demo/e2e/map-cards/`; `pnpm --filter ui build && pnpm --filter demo-e2e map-cards` |
| End-to-end | Demo app + collector in compose: a script drives the API and checks `/api/graph`; Playwright clicks in the demo and checks the map's text summary and that the request is animated once | `demo/e2e/` |
| Security | Demo login secrets never reach the collector unmasked; an HTML/JS payload in a body renders as text | `demo/e2e/tests/payload-security.spec.ts` (real demo login and note), SDK payload tests, collector redaction tests |

## Performance validation

- Ingest: a load generator replays recorded OTLP batches; measure spans/s, p99 handler time, RSS.
- SDK overhead: compare demo API latency with SDK off, on without bodies, on with bodies, under the same load
  (`demo/api/examples/sdk_overhead.rs`); for the web SDK, fetch latency and main-thread time in Chromium in the same
  modes (`pnpm --filter demo-e2e sdk-overhead`).
- UI: browser performance profile with a synthetic event stream at the target graph size.
- Each measurement is recorded in the table above with date, machine and command.

## Outbound HTTP and gRPC validation

This extends the existing local development workload to gateway-to-service calls, including streaming RPCs. No
new SLO, pool or concurrency budget is introduced: app clients own their deadlines, TLS, readiness and limits.
Per-call response capture uses the existing 256 KiB buffer ceiling and export queues; gRPC keeps no payload buffer.
There is no additional global state or background task. Persistence, caches and new services are not needed.

`sdk/rust/tests/outbound/` covers concurrent parent isolation, readiness, concrete request body preservation,
no-endpoint behavior, body/call cancellation, error-to-success transitions, metadata privacy, and real loopback
hyper HTTP/tonic unary and streaming transport. `collector/tests/fixtures/grpc_chain.json` exercises current and
legacy conventions across browser → gateway → gRPC service → database, including reversed batch order. UI tests
cover gRPC glyphs and response status; the frame-time harness includes long gRPC error labels.

2026-10-26, same local machine/Chromium setup as run G, now including gRPC packets: 600 frames over 10 s at each
DPR, draw p50/p95/max 1.40/1.60/2.60 ms (DPR 1), 1.40/1.60/2.30 ms (DPR 2); frame intervals
16.70/16.70/16.80 ms in both, no slow frames. All 14 browser E2E scenarios passed, including RPC status and
error-to-success recovery. Backend/database E2E: five calls, visible 0.47 s after the last request.

SDK regression measurement (2026-10-26): `sdk_overhead --rounds 5 --seconds 5`, the same 100 requests/s and four
connections as F, 2,500 requests per mode, no errors. Bodies on added median paired +0.10 ms p50 / +0.82 ms p95
over the mix; no-endpoint mode +0.02 / −0.03 ms; unreachable collector +0.09 / +0.71 ms. Without database queries,
bodies on added +0.03–0.04 ms p50 / +0.17–0.24 ms p95. Database-specific p95 differences ranged +0.18–1.87 ms;
this short run does not resolve them reliably (one bare slot reached p95 56 ms, one unreachable slot 118 ms).
It meets the mixed-workload 1 ms budget, but does not establish a per-database-route tail-latency guarantee.
This measures the shared server body observer regression; it is not a client transport throughput benchmark.

## Detailed node cards

2026-10-26, same local machine/Chromium setup: `pnpm --filter demo-e2e perf`. The 50-node, 100-edge graph now has
declared frontend frameworks, shell pages and two microfrontends per frontend; backend Rust/axum/SQLx/Tokio stacks,
incoming routes, PostgreSQL and Redis. The existing 200 concurrent requests and node flashes remain enabled. The
camera fits the whole graph, using compact card contents below the renderer's detail threshold.

| Device pixel ratio | Frames / 10 s | Draw p50 / p95 / max, ms | Frame interval p50 / p95 / max, ms | Late frames |
|---|---|---|---|---|
| 1 | 600 | 3.00 / 4.30 / 13.80 | 16.70 / 16.80 / 33.30 | 1 |
| 2 | 582 | 3.10 / 6.50 / 44.50 | 16.70 / 16.80 / 100.00 | 8 |

The JavaScript draw p95 stays below the 16.67 ms frame budget. This run had occasional late frames and does not
establish a no-dropped-frame guarantee; canvas rasterization is not included in draw timings. Desktop/mobile
browser checks cover expanded cards separately, including selection near the bottom of a taller frontend.

The real SDK → collector → UI chain was checked using native debug collector/API binaries, the demo Vite server
and PostgreSQL in Docker on the standard loopback ports: five database calls appeared within 0.44 s; the browser
confirmed the declared React and Rust/axum/SQLx/Tokio stacks. All 14 existing browser scenarios passed, alongside
four isolated map-card scenarios. The full Docker rebuild was not completed in this validation run.

Integration with the action timeline (2026-10-26): workspace Rust fmt/clippy/all-feature tests, 169 TypeScript tests,
workspace typechecks and the npm archive install check pass. The built UI passes 14 isolated desktop/mobile
scenarios and all 15 collector-backed browser scenarios against the current native demo binaries, including
action steps, metadata, redaction and HTTP/gRPC error recovery. The same frame-time harness passes the 16.67 ms
draw-p95 budget at DPR 1 and 2 after integration. These browser checks use Chromium and an emulated narrow
viewport; they do not establish physical-device or other-engine coverage.
