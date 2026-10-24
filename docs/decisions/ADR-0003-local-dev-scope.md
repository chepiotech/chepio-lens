# ADR-0003: MVP is a local development tool without authentication

## Status
Accepted

## Date
2026-10-23

## Context
Showing full request payloads is the core feature, and payloads hold secrets and personal data. Running safely in
production would need authentication, TLS, sampling, overhead limits and data retention rules: a large amount of
work that does not help the first goal, which is seeing a developer's own app.

## Decision
- The MVP targets local development (and a developer's private staging) only.
- No authentication or TLS. Listeners bind to `127.0.0.1`; in Docker, ports are published to `127.0.0.1` on the
  host only.
- SDKs are off unless an endpoint is configured, and production builds exclude them (`../architecture/security.md`).

## Rationale
Keeps the MVP small and fast to build, while localhost-only binding keeps data on the developer's machine.

## Alternatives considered
- **Production-ready from day one** (auth token, TLS, sampling): delays the first usable version by several phases.
- **Token on ingest only**: little protection while the UI stays open, so it adds complexity without real safety.

## Consequences
- Easier: no user accounts, keys or certificates.
- Constrained: anyone who can reach the ports reads everything. The tool must not run on shared or public networks
  or in production.
- Later: a production mode requires a new ADR that supersedes this one.

## Validation / fitness criteria
- A test asserts default listener addresses are loopback.
- The demo compose file publishes ports only on `127.0.0.1`.

## Reconsider when
- The tool is needed on a shared staging cluster or in production.
- More than one developer must watch the same collector.

## References
- `../architecture/security.md`, ADR-0004
