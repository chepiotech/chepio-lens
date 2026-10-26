# Components

Status (2026-10-25): `conventions`, the collector core (ingest, graph, store, UI API, SSE, embedded UI), both SDKs
with header/body capture and application logs, the UI map, filtered logs, request inspector and demo app are implemented.
Scope of this view: the MVP — frontend, backend and database of one instrumented app. Docker and Kubernetes layers
are planned later and are not described here.

## Context

```
 Instrumented app (developer's project)                 chepio-lens
┌──────────────────────────────┐
│ Browser app + web SDK        │──┐
├──────────────────────────────┤  │ OTLP/HTTP        ┌──────────────────────┐   HTTP + SSE   ┌───────────┐
│ Backend + Rust SDK           │──┴────────────────▶ │ Collector            │ ─────────────▶ │ UI (map,  │
│   └── SQL ──▶ Postgres       │   spans + logs  │ ingest, graph, store │                │ inspector)│
└──────────────────────────────┘                     └──────────────────────┘                └───────────┘
                                                                                      ▲
                                                                          Developer ──┘ (browser)
```

The database is never instrumented directly: it appears on the map through the database client spans that the
backend SDK emits.

## Components

| Component | Planned path | Language | Responsibility |
|---|---|---|---|
| Collector | `collector/` (crate `chepio-lens-collector`, binary `chepio-lens`) | Rust | Receives OTLP, normalizes and redacts spans and logs, derives the graph, keeps a bounded in-memory store, serves the UI API, SSE and the embedded UI |
| Conventions | `conventions/` (crate `chepio-lens-conventions`) | Rust | Attribute keys, legacy-to-stable name mapping, redaction rules; shared test vectors in `conventions/testdata/` |
| UI | `ui/` | TypeScript, React, Vite, Canvas 2D | Map page and request inspector; built into static files that the collector embeds |
| Rust SDK | `sdk/rust/` (crate `chepio-lens-sdk`) | Rust | One-call setup of OpenTelemetry for axum + sqlx backends; HTTP/gRPC server and client spans, database spans; payload capture and app logs with redaction |
| Web SDK | `sdk/web/` (package `chepio-lens-web`) | TypeScript | One-call setup of OpenTelemetry in the browser; fetch spans; `traceparent` propagation; redacted payloads and console logs; browser actions |
| Demo app | `demo/` (`demo/web`, `demo/api`, `demo/compose.yaml`) | React + Vite, Rust (axum, sqlx), Postgres | The reference app to instrument; used by end-to-end tests |

Workspaces: one Cargo workspace (collector, conventions, Rust SDK, demo API) and one pnpm workspace (UI, web SDK,
demo web) at the repository root.

Distribution: the collector as the image `ghcr.io/chepiotech/chepio-lens` (amd64 and arm64, pushed from `v*` tags)
run with `collector/compose.yaml`, or installed from a clone (ADR-0011); the Rust SDK as a git dependency pinned to a
tag, the web SDK as a tarball attached to each GitHub release, or with pnpm from the git subdirectory before the first
release (ADR-0014). How to connect an app: `docs/workflows/connect-a-project.md`.
The image contains a static musl binary in scratch, its license and dependency evidence (ADR-0017).

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
- The web SDK reimplements redaction and node-metadata normalization in TypeScript and must pass the same test
  vectors as the Rust implementation.

## Collector internals (hexagonal)

Layers follow the global import groups; arrows show allowed imports.

| Layer | Holds | May import |
|---|---|---|
| `domain/` | normalized span, log record, request, node, edge, graph derivation, link window logic; no I/O | conventions |
| `ports/` | `TraceStore`, `EventPublisher` traits | domain |
| `services/` | `Ingest` (normalize → redact → store → derive graph → publish), `Query` (graph, requests) | domain, ports |
| `repositories/` | bounded in-memory `TraceStore` (ADR-0005) | domain, ports |
| `adapters/` | OTLP decoding (protobuf and JSON) into domain spans and log records; SSE broadcaster | domain, ports |
| `handlers/` | OTLP/HTTP endpoint, UI API, SSE endpoint, static UI | services, domain |
| `types/` | Wire types shared by layers: UI API shapes exported to TypeScript (ADR-0009), OTLP encoding, SSE messages | domain |
| `app.rs` | Composition root: configuration from the environment, wiring of all layers | everything |

## UI internals

- React renders the logs panel, request inspector, floating canvas controls and page footer with
  `<ChepioTechFooter />`. The live and example maps have no page header or introductory copy. The top-left console
  icon opens the activity panel; the top-right settings icon opens a centered native modal dialog, with General,
  Console and Map sections. Connection status, session reset, example/live navigation, console docking, node focus
  and the packet legend are available there. Zoom and fit controls use icons on the canvas. Settings support
  keyboard tab navigation, modal focus containment, Escape, backdrop dismissal and focus return to the opener.
- The map is one `<canvas>` driven by a renderer module outside React's render cycle (ADR-0006). React passes state
  in and receives selection events out. `ui/src/map/`: `layoutGraph` (deterministic columns), `geometry` (camera,
  curves, hit-testing), `graphState` (snapshot + events), `MapRenderer` (canvas drawing and input); only the
  renderer touches the canvas, so the rest is unit-tested.
- Node cards share a calculated height with layout, hit-testing and camera fitting. Frontends have browser chrome,
  framework strips and optional microfrontend sections; services list incoming endpoints; Redis database nodes
  render as caches, with dashed cache links. Incoming route statistics are aggregated across callers. Navigation
  paths come only from frontend action records' `url.path`, never outgoing API URLs, and are held in memory
  (32 paths per node, 200 nodes, 160 characters per path; query and fragment removed). This is observed navigation
  while the map is open, not discovery of an application's complete router manifest.
- Both SDKs declare technology, page and microfrontend metadata in their settings, exported as an optional OTLP
  resource attribute. The collector normalizes it, shares it across records in a batch, and carries it into snapshot
  nodes and SSE updates. The contract and limits are in `interfaces.md`. Cards combine declared pages with observed
  navigation; microfrontends and remaining shell pages have separate sections. Unknown stacks are labeled as
  unreported. Redis and PostgreSQL marks come from `db_system`; the example provides explicit React/Vue and
  Rust/axum/SQLx metadata. There is no automatic dependency or framework discovery.
- `Example map` in settings opens `?example=architecture`: an isolated illustrative graph, with no collector
  requests or writes, including when its console or settings are open. Settings identify the illustrative source;
  its console links to the live map for real requests. It uses the live renderer, selection details and accessible
  summary. The Map settings node picker centers and enlarges a node at any viewport width. Map keyboard controls:
  left/right inspect nodes, +/- zoom, 0 fits, Escape clears selection.
  Local Devicon SVGs retain their MIT license and are emitted as files (no data URLs), honoring the collector CSP.
  Build the UI, then run `pnpm --filter demo-e2e map-cards` for isolated desktop/mobile browser checks.
- Packet icons: `requestPulses` places each hop on screen and decides when its request arrives and its response
  leaves (before and after the calls nested in it); `packets` picks the icon, colour and label for a hop's request and
  response and for log and action flashes at nodes; `MapRenderer` draws them as `Path2D` strokes. The icon outlines
  are Lucide path data generated into `ui/src/map/icons/lucideIcons.ts` by `ui/scripts/importLucideIcons.mjs`, not a
  package dependency (ADR-0013). `MapLegend` explains them with the same path data as React SVG elements.
- State: the graph snapshot from `GET /api/graph`, then incremental SSE events; a `resync` event triggers a fresh
  snapshot. Events received during a snapshot request are buffered by node/edge id and merged when it completes,
  keeping the higher edge call count so a slow snapshot cannot restore an old error. A newer load, reset or
  unmount invalidates the previous load.
- The activity panel overlays the entire page (including the footer) on the left, right or bottom. Opening,
  resizing and closing it do not resize the canvas or change its camera. Placement changes only in Console
  settings; the panel itself has a close button and a resize edge. Its placement, dimensions and selected
  Actions/Lines view are stored in `localStorage`. Log and request contents stay in memory. Edge selection opens its filtered log; a line selects
  its trace and span in the inspector. Per-route edge statistics remain available above the log.
- `useLogs` reads filtered pages from `GET /api/logs`; SSE log/request events coalesce refreshes so edge linking and
  filter semantics remain on the collector. Filters cancel previous loads. The list is bounded and pauses live
  updates while the reader visits earlier lines (`runtime.md`).
- The inspector loads `GET /api/requests/{trace_id}` and refreshes when the selected request changes in SSE. It
  renders span offsets as received, flags children starting before their parents, and shows headers, bodies, SQL,
  status and events as React text. Valid JSON bodies are formatted; truncation, redaction and invalid JSON are
  explicit. Unknown/evicted requests and failed loads have recoverable states.

App log serialization belongs to the SDKs; collector log normalization/redaction belongs to its ingest service.
The UI uses nullable log context directly and fetches request details only when a trace id exists. ADR-0012 records
the synchronous browser action boundary; no new dependency between SDKs and collector was introduced.
