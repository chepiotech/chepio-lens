# ADR-0010: SQL parameter values are not captured

## Status
Accepted. Supersedes the "SQL parameter values are opt-in" part of ADR-0004.

## Date
2026-10-25

## Context
ADR-0004 made SQL parameter values opt-in (`CHEPIO_LENS_CAPTURE_SQL_PARAMS`, attribute `lens.db.query.parameters`).
ADR-0008 then built database spans from sqlx query events, which carry the SQL text but no parameter values, so the
option could not be implemented. The request inspector needs a decision before it is built.

## Decision
- The SDKs capture `db.query.text` only. Parameter values are not captured.
- `CHEPIO_LENS_CAPTURE_SQL_PARAMS` and `lens.db.query.parameters` are removed from the contract
  (`../architecture/interfaces.md`) and from the `conventions` crate.

## Rationale
- Parameter values have no names, so the key-based redaction in `../architecture/security.md` cannot protect them: a
  password bound to `$2` would be shown as is. Leaving them out keeps secrets out of the collector by construction.
- sqlx 0.9 offers no access to bound values from outside the query (ADR-0008); getting them would need app changes.

## Alternatives considered
- **An explicit SDK call next to each query** (e.g. `lens.record_query_params(&[...])`): values become visible, but
  every call site in the app changes, and the values still cannot be masked.
- **A wrapper type implementing `sqlx::Executor`**: rejected in ADR-0008 for its cost to the app; values would still
  be unmasked.

## Consequences
- Easier: one fewer option and attribute; no unmaskable data in spans.
- Harder: debugging a query by its values needs the app's own logs (after ROADMAP 4.9, they appear in the logs panel
  next to the query).
- Queries that inline values into the SQL text still show them (known gap in `security.md`).

## Validation / fitness criteria
- `conventions::keys` has no parameter key; no SDK writes one (code review and `rg lens.db.query.parameters`).

## Reconsider when
- A real project needs parameter values to debug and accepts that they are shown unmasked, or sqlx exposes bound
  values with type information that allows masking.

## References
- ADR-0004, ADR-0008, `../architecture/security.md`, `../architecture/interfaces.md`
