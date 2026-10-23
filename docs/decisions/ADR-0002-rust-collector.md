# ADR-0002: The collector is written in Rust

## Status
Accepted

## Date
2026-10-23

## Context
The collector receives spans, builds the graph and serves the UI. It runs next to the developer's app (as a local
binary or a container) and later inside Kubernetes as a sidecar or DaemonSet, where memory and startup time matter.
The UI is TypeScript in any case. The owner's priority language is Rust.

## Decision
Write the collector, the shared `conventions` crate and the backend SDK for Rust apps in Rust. The owner chose this
on 2026-10-23 after comparing Rust, Go and TypeScript.

Planned crates (licenses checked again when added): `tokio` (MIT), `axum` (MIT), `tower-http` (MIT),
`opentelemetry-proto` (Apache-2.0), `prost` (Apache-2.0), `serde` and `serde_json` (MIT or Apache-2.0),
`rust-embed` (MIT) for embedding the built UI. Rust SDK: `opentelemetry`, `opentelemetry_sdk`, `opentelemetry-otlp`
(Apache-2.0), `tracing` and `tracing-opentelemetry` (MIT).

## Rationale
- One small binary with low memory use and fast startup, which matters for later Kubernetes deployment.
- Mature crates for OTLP, HTTP and, later, Docker (`bollard`, Apache-2.0) and Kubernetes (`kube`, Apache-2.0).
- The same language as the owner's backends, so the Rust SDK and the collector share the `conventions` crate.

## Alternatives considered
- **Go**: the OpenTelemetry Collector and the Kubernetes client are native Go, and it compiles fast. But it is not
  the owner's priority language, `nil` errors show up only at runtime, and there are no sum types.
- **TypeScript (Node)**: the same language as the UI and the fastest MVP. But it uses more memory, is slower under a
  heavy span stream, has more runtime errors and suits an in-cluster agent less well.

## Consequences
- Harder: slower prototyping and longer compile times; async and the borrow checker add complexity.
- Constrained: redaction exists twice, in Rust (`conventions`) and in TypeScript (web SDK). Shared test vectors keep
  them equal.
- SDKs for Node or .NET backends will be written in their own languages.

## Validation / fitness criteria
- Budgets in `../architecture/quality-attributes.md` (throughput, memory, startup) are met and recorded.

## Reconsider when
- Development speed blocks the roadmap for more than one phase because of Rust specifically.

## References
- `../architecture/components.md`
