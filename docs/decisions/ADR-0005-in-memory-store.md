# ADR-0005: The collector keeps data in a bounded in-memory store

## Status
Accepted

## Date
2026-10-23

## Context
The collector needs recent requests and the live graph. In local development, history older than the current
session is rarely useful, and payloads on disk would be one more place where secrets can leak.

## Decision
No database in the MVP. Requests live in a ring buffer bounded by count and bytes; the graph lives in memory for
the collector's lifetime. Bounds are in `../architecture/runtime.md`. Everything is gone on restart.

## Rationale
- Zero setup: the collector is a single binary with no files to manage.
- No payloads at rest (`../architecture/security.md`).
- Simplest storage that meets the requirements; it sits behind the `TraceStore` port, so it can be replaced.

## Alternatives considered
- **SQLite** (public domain; `rusqlite`, MIT): history across restarts and SQL queries over requests, but adds
  disk I/O, schema migrations and payloads at rest.
- **DuckDB** (MIT): strong analytics, but more than the MVP needs.
- **ClickHouse or Tempo**: built for production telemetry, heavy for a local tool; Tempo is AGPL-3.0 and excluded
  by the license policy.

## Consequences
- Easier: no migrations, nothing to clean up.
- Constrained: no history after restart; long sessions lose old requests to eviction.

## Validation / fitness criteria
- Memory stays within the RSS budget in `../architecture/quality-attributes.md` at default bounds.

## Reconsider when
- The owner needs history across restarts or comparisons between sessions.
- Default bounds regularly evict requests the developer still needs.

## References
- `../architecture/data.md`, `../architecture/runtime.md`
