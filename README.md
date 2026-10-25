# chepio-lens

A live map of a running full-stack app. chepio-lens shows the frontend, the backend and the database as nodes on a
canvas and animates every request along the path it takes: an HTTP or HTTPS document with its body type on the way
out, the SQL query by operation, the response or the failure on the way back, and log lines and user actions at
their nodes. Open any request to see its timeline, headers, bodies and SQL.

**Status:** early development with a working local demo: the browser → API → database map, live filtered logs with
app log records (Rust `tracing`, browser `console.*`) and user actions (clicks, submits, navigation), request
waterfall, headers, bodies, SQL and errors.
See [the demo guide](demo/README.md) to run it and use the logs panel and inspector.

## How it works

```
Your app                                        chepio-lens
┌──────────────────────────┐
│ Browser + web SDK        │──┐  OTLP/HTTP     ┌───────────────┐   HTTP + SSE   ┌──────────────────┐
│ Backend + Rust SDK       │──┴─────────────▶  │ Collector     │ ─────────────▶ │ Map and inspector│
│   └── SQL ──▶ Postgres   │  spans + payloads │ (Rust)        │                │ (browser)        │
└──────────────────────────┘                   └───────────────┘                └──────────────────┘
```

- The SDKs are thin wrappers around [OpenTelemetry](https://opentelemetry.io/). They record HTTP calls and database
  queries, add request and response payloads, and redact sensitive headers and configured JSON/form fields before
  export (limits and known gaps are described in [security](docs/architecture/security.md)).
- The collector receives the spans, works out which component talks to which, and serves the map.
- Any service that already exports OpenTelemetry traces over OTLP/HTTP appears on the map too, without payloads.

The first version targets local development of React + Rust (axum, sqlx) + Postgres apps. Docker and Kubernetes
views, more backend languages and a production mode are planned later.

## Run the collector

With Docker, from a clone, or with the service in [`collector/compose.yaml`](collector/compose.yaml) copied into
your project's compose file:

```sh
docker compose -f collector/compose.yaml up -d
```

The image `ghcr.io/chepiotech/chepio-lens` (amd64 and arm64) is published from `v0.1.0` on. Until then build it
first: `docker build -f collector/Dockerfile -t chepio-lens:dev .`, then run the command above with
`CHEPIO_LENS_IMAGE=chepio-lens:dev`.

Without Docker, from a clone (Rust from `rust-toolchain.toml`, Node 24, pnpm):

```sh
pnpm install --frozen-lockfile --filter ui... && pnpm --filter ui build
cargo install --path collector --locked
chepio-lens
```

The map is at http://localhost:4320; SDKs send to http://localhost:4318. A browser app served from an origin other
than `http://localhost:5173` must be listed in `CHEPIO_LENS_CORS_ORIGINS`, or its spans are refused. `cargo install
--git` builds a collector without the map ([ADR-0011](docs/decisions/ADR-0011-collector-distribution.md)).

## Documentation

- Architecture: [components](docs/architecture/components.md), [data](docs/architecture/data.md),
  [interfaces](docs/architecture/interfaces.md), [runtime](docs/architecture/runtime.md),
  [security](docs/architecture/security.md), [quality attributes](docs/architecture/quality-attributes.md)
- Domain: [glossary](docs/domain/glossary.md), [invariants](docs/domain/invariants.md)
- Decisions: [docs/decisions](docs/decisions/README.md)
- Demo app used for development and end-to-end tests: [demo/README.md](demo/README.md)

## Security note

chepio-lens shows request payloads. It is meant for local development only: it has no authentication and listens on
`127.0.0.1` by default. Do not run it in production or expose it to a shared network.

## License

Licensed under either of [Apache License, Version 2.0](LICENSE-APACHE) or [MIT license](LICENSE-MIT), at your
option. Unless you explicitly state otherwise, any contribution you submit for inclusion in this project, as defined
in the Apache-2.0 license, is dual licensed as above, without any additional terms or conditions.

The map's icons are outlines from [Lucide](https://lucide.dev) (ISC; some derived from Feather, MIT); their license
texts are in [ui/src/map/icons/LICENSE-lucide.txt](ui/src/map/icons/LICENSE-lucide.txt).
