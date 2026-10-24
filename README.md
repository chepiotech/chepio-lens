# chepio-lens

A live map of a running full-stack app. chepio-lens shows the frontend, the backend and the database as nodes on a
canvas, animates every request along the path it takes, and lets you open any request to see its timeline, headers,
bodies and SQL.

**Status:** early development. The repository holds the workspace scaffold and the design documents below; no
feature works yet.

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
  queries, add request and response payloads, and mask secrets before anything leaves your app.
- The collector receives the spans, works out which component talks to which, and serves the map.
- Any service that already exports OpenTelemetry traces over OTLP/HTTP appears on the map too, without payloads.

The first version targets local development of React + Rust (axum, sqlx) + Postgres apps. Docker and Kubernetes
views, more backend languages and a production mode are planned later.

## Documentation

- Architecture: [components](docs/architecture/components.md), [data](docs/architecture/data.md),
  [interfaces](docs/architecture/interfaces.md), [runtime](docs/architecture/runtime.md),
  [security](docs/architecture/security.md), [quality attributes](docs/architecture/quality-attributes.md)
- Domain: [glossary](docs/domain/glossary.md), [invariants](docs/domain/invariants.md)
- Decisions: [docs/decisions](docs/decisions/README.md)

## Security note

chepio-lens shows request payloads. It is meant for local development only: it has no authentication and listens on
`127.0.0.1` by default. Do not run it in production or expose it to a shared network.

## License

Licensed under either of [Apache License, Version 2.0](LICENSE-APACHE) or [MIT license](LICENSE-MIT), at your
option. Unless you explicitly state otherwise, any contribution you submit for inclusion in this project, as defined
in the Apache-2.0 license, is dual licensed as above, without any additional terms or conditions.
