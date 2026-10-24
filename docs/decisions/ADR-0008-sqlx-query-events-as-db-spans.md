# ADR-0008: The Rust SDK turns sqlx query events into database client spans

## Status
Accepted

## Date
2026-10-24

## Context
The map shows a database node only if the backend SDK emits database client spans (`components.md`). sqlx has no
OpenTelemetry instrumentation. A spike on 2026-10-24 (sqlx 0.9.0, Postgres 17, tracing 0.1.44) found:

- sqlx creates no tracing spans. For every statement it emits one tracing event at completion: target
  `sqlx::query`, level `DEBUG` by default (`ConnectOptions::log_statements`), fields `summary`, `db.statement`,
  `rows_affected`, `rows_returned`, `elapsed`, `elapsed_secs`.
- `summary` is the statement cut with `…` when it is long or spans lines; then `db.statement` holds the full text
  (with leading newlines), otherwise `db.statement` is empty.
- A failing statement emits the same event with no error field.
- The event carries no host, port, database name or pool identity, and no parameter values.
- The event is recorded in the caller's context: a tracing layer sees `opentelemetry::Context::current()` that the
  caller attached to the future with `FutureExt::with_context`, across `.await` points and thread switches on the
  multi-threaded Tokio runtime.
- A global `LevelFilter::INFO` in the app's subscriber disables the event at its callsite, so no layer sees it.

## Decision
- The Rust SDK installs a tracing layer that turns each `sqlx::query` event into an OpenTelemetry client span:
  - parent: the current OpenTelemetry context, which the SDK's axum layer attaches to the request future;
  - end: the event time; start: end minus `elapsed`;
  - `db.query.text`: `db.statement` trimmed when not empty, else `summary`;
  - `db.system.name`, `server.address`, `server.port`, `db.namespace`: from the connect options the app passes to
    the SDK once at setup.
- The SDK checks at setup whether `sqlx::query` events at `DEBUG` are enabled and logs one warning with the fix
  when they are not.
- tracing-opentelemetry is not needed for this; the SDK uses the OpenTelemetry API directly.

## Rationale
- Zero changes at query call sites: transactions, `&PgPool`, `&mut PgConnection` and the query macros are all
  covered, which keeps setup within F4 (≤ 10 lines per app).
- Timing and SQL text are exact enough for the map and the waterfall.

## Alternatives considered
- **Wrapper type implementing `sqlx::Executor`**: gives errors, parameters and per-pool identity, but the app has to
  replace `PgPool` in every signature and state type, and transactions bypass the wrapper. Breaks F4.
- **Helper around each query future**: changes every call site.
- **Postgres-side data** (`pg_stat_statements`, server logs): no trace context, so queries cannot be linked to
  requests.
- **Native spans in sqlx**: not available in 0.9.

## Consequences
- Database spans never carry an error status; a failed query shows on the server span of the request (500), not on
  the database edge.
- All sqlx queries of one service map to one database node (the connect options given at setup). A service with
  several databases is shown as one.
- SQL parameter values are not available: `lens.db.query.parameters` and `CHEPIO_LENS_CAPTURE_SQL_PARAMS` cannot be
  implemented on this mechanism.
- The event's field names are not a stable sqlx API: the SDK pins sqlx 0.9 and an integration test against Postgres
  checks the mapping.
- Apps with a global log filter must allow `sqlx::query=debug` (or use per-layer filters); the setup warning says so.

## Validation / fitness criteria
- SDK integration test against Postgres: a request through the axum layer that runs queries produces a server span
  and database client spans with that parent, the SQL text, and a duration at least the `pg_sleep` time; a failing
  query still produces its database span.
- A test with a global `INFO` filter asserts the setup warning.

## Reconsider when
- sqlx ships spans, or adds an error field or connection identity to its query event.
- The owner needs SQL parameter values, query errors on database edges, or several databases per service.

## References
- `../architecture/interfaces.md` (SDK public API), `../architecture/components.md`, `../domain/invariants.md` (I4, I6)
