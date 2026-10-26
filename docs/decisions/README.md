# Decisions

One decision per file. An accepted decision is never edited: a new ADR supersedes it.

| ADR | Title | Status |
|---|---|---|
| [ADR-0001](ADR-0001-opentelemetry-otlp.md) | OpenTelemetry and OTLP/HTTP as the only telemetry format | Accepted |
| [ADR-0002](ADR-0002-rust-collector.md) | The collector is written in Rust | Accepted |
| [ADR-0003](ADR-0003-local-dev-scope.md) | MVP is a local development tool without authentication | Accepted |
| [ADR-0004](ADR-0004-payload-capture-in-sdk.md) | Payloads are captured and redacted in the SDK | Accepted; SQL parameter part superseded by ADR-0010 |
| [ADR-0005](ADR-0005-in-memory-store.md) | The collector keeps data in a bounded in-memory store | Accepted |
| [ADR-0006](ADR-0006-canvas-2d-map.md) | The map is drawn on Canvas 2D without a graphics library | Accepted |
| [ADR-0007](ADR-0007-license-and-distribution.md) | Dual MIT OR Apache-2.0 license; SDKs ship as git dependencies until v0.1.0 | Accepted; web SDK distribution superseded by ADR-0014 |
| [ADR-0008](ADR-0008-sqlx-query-events-as-db-spans.md) | The Rust SDK turns sqlx query events into database client spans | Accepted |
| [ADR-0009](ADR-0009-ui-api-types-from-rust.md) | TypeScript types for the UI API are generated from the collector's Rust types | Accepted |
| [ADR-0010](ADR-0010-no-sql-parameter-values.md) | SQL parameter values are not captured | Accepted |
| [ADR-0011](ADR-0011-collector-distribution.md) | The collector ships as a multi-architecture image on GHCR from v* tags, or is installed from a clone | Accepted |
| [ADR-0012](ADR-0012-app-logs-and-browser-actions.md) | OTLP app logs and synchronous browser action correlation | Accepted |
| [ADR-0013](ADR-0013-packet-icons-from-lucide-path-data.md) | Packet icons are Lucide path data drawn on the canvas, not an icon package | Accepted |
| [ADR-0014](ADR-0014-sdk-distribution.md) | The web SDK ships as a tarball on GitHub releases; the Rust SDK stays a git dependency | Accepted |
| [ADR-0015](ADR-0015-outbound-http-and-grpc.md) | One Tower layer for outbound HTTP and gRPC; status through trailers | Accepted |
| [ADR-0016](ADR-0016-action-timeline.md) | Activity is grouped by user action and ordered by the call tree | Accepted |
| [ADR-0017](ADR-0017-static-collector-image.md) | Static musl collector in scratch with native dependency evidence | Accepted |
