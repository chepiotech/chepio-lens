# ADR-0009: TypeScript types for the UI API are generated from the collector's Rust types

## Status
Accepted

## Date
2026-10-24

## Context
The UI reads the collector's UI API (`GET /api/graph`, SSE events, `GET /api/stats`). Both ship in one binary, so
there is no compatibility window, but the JSON shapes must match exactly: a renamed field breaks the map silently.
`interfaces.md` left open how the UI gets its types.

## Decision
- The UI API shapes live in `collector/src/types/api.rs` and derive `ts_rs::TS` (ts-rs, MIT) with `#[ts(export)]`.
- `cargo test` writes one `.ts` file per type to `ui/src/api/generated/` (`TS_RS_EXPORT_DIR` in
  `.cargo/config.toml`). The generated files are committed; the UI imports only from there.
- CI fails when `ui/src/api/generated/` differs from what `cargo test` produced.
- 64-bit counters are exported as `number` (they stay far below 2^53); timestamps are decimal strings
  (`data.md`).

## Rationale
- One source of truth: a change to the Rust type changes the TypeScript type in the same commit.
- No schema files or extra toolchain steps; the export runs with the tests that already run.

## Alternatives considered
- **Hand-written TypeScript types with JSON fixtures**: no dependency, but two definitions of every type, kept equal
  only where a fixture happens to cover a field.
- **JSON Schema** (`schemars`, MIT) **plus a schema-to-TypeScript generator**: a standard format, but two tools and a
  Node build step for the same result.
- **specta** (MIT): similar to ts-rs, still a release candidate in 2026-10.

## Consequences
- Easier: field renames and new fields reach the UI type-checked.
- Constrained: UI API changes start in Rust; generated files carry ts-rs's "do not edit" header and must not be edited.
- After changing `types/api.rs`, run `cargo test -p chepio-lens-collector` and commit the regenerated files.

## Validation / fitness criteria
- CI step "Generated UI API types are committed" passes.
- `pnpm --filter ui typecheck` passes against the generated files.

## Reconsider when
- The UI API gets consumers outside this repository that need a versioned, language-neutral schema (OpenAPI).

## References
- `../architecture/interfaces.md` (UI API), `../architecture/data.md` (serialization)
