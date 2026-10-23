# ADR-0001: OpenTelemetry and OTLP/HTTP as the only telemetry format

## Status
Accepted

## Date
2026-10-23

## Context
chepio-lens must see HTTP calls, database queries and their payloads in apps written in different languages
(the MVP targets Rust backends and browser frontends; Node and .NET come later). Writing our own agents and wire
protocol for every language is the largest possible amount of work and would not reuse the instrumentation that
already exists for most frameworks.

## Decision
- SDKs produce OpenTelemetry spans and export them over OTLP/HTTP (protobuf from Rust, JSON from the browser).
- The collector accepts only OTLP/HTTP `POST /v1/traces`.
- Payloads (bodies, SQL parameters) travel as span attributes in the `lens.*` namespace; everything else uses the
  OpenTelemetry semantic conventions.

## Rationale
- OpenTelemetry is the vendor-neutral standard (CNCF), with SDKs and auto-instrumentation for every target language,
  all under Apache-2.0.
- Any service that already exports OTLP appears on the map without our SDK (without payloads).
- One transport for everything: no second channel for payloads.

## Alternatives considered
- **Own protocol and agents per language**: full control, but many times the work and no ecosystem. Rejected.
- **eBPF capture without code changes** (OpenTelemetry eBPF Instrumentation, Pixie, Coroot; all Apache-2.0): no
  SDK needed, but Linux only, needs root privileges, works on macOS only inside the Docker VM, and HTTPS bodies are
  harder to see. Kept as a possible later source that feeds the same OTLP ingest.
- **Commercial APM** (Datadog, New Relic): not embeddable in our own tool. Rejected.

## Consequences
- Easier: any OTel-instrumented backend shows up immediately; we write thin SDK wrappers instead of agents.
- Harder: semantic conventions evolve, so the collector must map legacy names (invariant I8).
- Constrained: no OTLP/gRPC in the MVP; SDKs whose exporter defaults to gRPC (.NET, Java) must be configured for
  `http/protobuf`.
- Risk: OpenTelemetry does not capture bodies; that part is ours (ADR-0004).

## Validation / fitness criteria
- Collector integration tests ingest fixtures produced by stock OpenTelemetry exporters, not only by our SDKs.
- SDK crates and packages have no dependency on collector code (checked when the workspaces exist).

## Reconsider when
- A target SDK cannot export OTLP/HTTP → add OTLP/gRPC ingest.
- Users need zero-code instrumentation → add an eBPF source.

## References
- OpenTelemetry specification and OTLP: https://opentelemetry.io/docs/specs/otlp/
- Semantic conventions: https://opentelemetry.io/docs/specs/semconv/
- `../architecture/interfaces.md`
