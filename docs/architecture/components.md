# Components

Status (2026-10-25): `conventions`, the collector core (ingest, graph, store, UI API, SSE, embedded UI), both SDKs
with header and body capture, the UI map, filtered logs, request inspector and demo app are implemented.
Scope of this view: the MVP — frontend, backend and database of one instrumented app. Docker and Kubernetes layers
are planned later and are not described here.

## Context

```
 Instrumented app (developer's project)                 chepio-lens
┌──────────────────────────────┐
│ Browser app + web SDK        │──┐
├──────────────────────────────┤  │ OTLP/HTTP        ┌──────────────────────┐   HTTP + SSE   ┌───────────┐
│ Backend + Rust SDK           │──┴────────────────▶ │ Collector            │ ─────────────▶ │ UI (map,  │
│   └── SQL ──▶ Postgres       │   spans + payloads  │ ingest, graph, store │                │ inspector)│
└──────────────────────────────┘                     └──────────────────────┘                └───────────┘
                                                                                      ▲
                                                                          Developer ──┘ (browser)
```

The database is never instrumented directly: it appears on the map through the database client spans that the
backend SDK emits.

## Components

| Component | Planned path | Language | Responsibility |
|---|---|---|---|
| Collector | `collector/` (crate `chepio-lens-collector`, binary `chepio-lens`) | Rust | Receives OTLP, normalizes and redacts spans, derives the graph, keeps a bounded in-memory store, serves the UI API, SSE and the embedded UI |
| Conventions | `conventions/` (crate `chepio-lens-conventions`) | Rust | Attribute keys, legacy-to-stable name mapping, redaction rules; shared test vectors in `conventions/testdata/` |
| UI | `ui/` | TypeScript, React, Vite, Canvas 2D | Map page and request inspector; built into static files that the collector embeds |
| Rust SDK | `sdk/rust/` (crate `chepio-lens-sdk`) | Rust | One-call setup of OpenTelemetry for axum + sqlx backends; HTTP server and database spans; payload capture with redaction |
| Web SDK | `sdk/web/` (package `chepio-lens-web`) | TypeScript | One-call setup of OpenTelemetry in the browser; fetch spans; `traceparent` propagation; payload capture with redaction |
| Demo app | `demo/` (`demo/web`, `demo/api`, `demo/compose.yaml`) | React + Vite, Rust (axum, sqlx), Postgres | The reference app to instrument; used by end-to-end tests |

Workspaces: one Cargo workspace (collector, conventions, Rust SDK, demo API) and one pnpm workspace (UI, web SDK,
demo web) at the repository root.

## Allowed dependencies

```
demo ──▶ sdk/rust, sdk/web           (like any external project)
sdk/rust ──▶ conventions
collector ──▶ conventions
ui ──▶ collector UI API (HTTP only)
sdk/web ──▶ conventions/testdata (tests only)
```

- SDKs never import collector code and the collector never imports SDK code. They meet only at OTLP and the
  attribute contract in `interfaces.md` (ADR-0001).
- The UI talks only to the collector UI API, never to OTLP or the SDKs.
- `conventions` has no I/O and no dependency on OpenTelemetry SDK crates, so both the collector and the Rust SDK can
  use it.
- The web SDK reimplements redaction in TypeScript and must pass the same test vectors as the Rust implementation.

## Collector internals (hexagonal)

Layers follow the global import groups; arrows show allowed imports.

| Layer | Holds | May import |
|---|---|---|
| `domain/` | normalized span, request, node, edge, graph derivation, link window logic; no I/O | conventions |
| `ports/` | `TraceStore`, `EventPublisher` traits | domain |
| `services/` | `Ingest` (normalize → redact → store → derive graph → publish), `Query` (graph, requests) | domain, ports |
| `repositories/` | bounded in-memory `TraceStore` (ADR-0005) | domain, ports |
| `adapters/` | OTLP decoding (protobuf and JSON) into domain spans; SSE broadcaster | domain, ports |
| `handlers/` | OTLP/HTTP endpoint, UI API, SSE endpoint, static UI | services, domain |
| `types/` | Wire types shared by layers: UI API shapes exported to TypeScript (ADR-0009), OTLP encoding, SSE messages | domain |
| `app.rs` | Composition root: configuration from the environment, wiring of all layers | everything |

## UI internals

- React renders the logs panel, request inspector, toolbar and page footer with `<ChepioTechFooter />`.
- The map is one `<canvas>` driven by a renderer module outside React's render cycle (ADR-0006). React passes state
  in and receives selection events out. `ui/src/map/`: `layoutGraph` (deterministic columns), `geometry` (camera,
  curves, hit-testing), `graphState` (snapshot + events), `MapRenderer` (canvas drawing and input); only the
  renderer touches the canvas, so the rest is unit-tested.
- State: the graph snapshot from `GET /api/graph`, then incremental SSE events; a `resync` event triggers a fresh
  snapshot. Events received during a snapshot request are buffered by node/edge id and merged when it completes,
  keeping the higher edge call count so a slow snapshot cannot restore an old error. A newer load, reset or
  unmount invalidates the previous load.
- The activity panel docks right or bottom; only its dock and dimensions are stored in `localStorage`. Log and
  request contents stay in memory. Edge selection opens its filtered log; a line selects its trace and span in the
  inspector. Per-route edge statistics remain available above the log.
- `useLogs` reads filtered pages from `GET /api/logs`; SSE log/request events coalesce refreshes so edge linking and
  filter semantics remain on the collector. Filters cancel previous loads. The list is bounded and pauses live
  updates while the reader visits earlier lines (`runtime.md`).
- The inspector loads `GET /api/requests/{trace_id}` and refreshes when the selected request changes in SSE. It
  renders span offsets as received, flags children starting before their parents, and shows headers, bodies, SQL,
  status and events as React text. Valid JSON bodies are formatted; truncation, redaction and invalid JSON are
  explicit. Unknown/evicted requests and failed loads have recoverable states.
