# Invariants

Rules that must stay true. Each gets a test when its code is written; the "Enforced by" column then names the test.

| ID | Invariant | Enforced by |
|---|---|---|
| I1 | The instrumented app never fails, blocks or slows down measurably because of chepio-lens. SDK export is asynchronous with a bounded queue and drops spans on overflow or error. | planned: SDK tests with an unreachable endpoint |
| I2 | Payload values are redacted in the SDK before export and again by the collector on ingest, using the defaults in `../architecture/security.md`. Configuration can add keys, never remove defaults. | planned: shared vectors in `conventions/testdata/` |
| I3 | A service node's id is `svc:<service.name>`. Its kind is `frontend` when the resource has `telemetry.sdk.language = webjs` or `lens.node.kind = frontend`, else `service`. | planned: collector domain tests |
| I4 | A database node's id is `db:<db.system.name>:<server.address>:<server.port>/<db.namespace>`, omitting missing parts. Every service using the same database points to one node. | planned: collector domain tests |
| I5 | An external node's id is `ext:<server.address>:<server.port>`. | planned: collector domain tests |
| I6 | Edges come only from span data: a client span linked to a server span of another service gives an http edge; a client span with a database system gives a db edge; an unlinked client span gives an edge to an external node after the link window. | planned: collector domain tests |
| I7 | Linking gives the same graph whatever order the spans arrive in, within the link window. | planned: property test over permutations |
| I8 | Collector domain code reads only normalized names; legacy semconv names are mapped once, at ingest. | planned: ingest tests with legacy fixtures |
| I9 | Every collector buffer, map and channel has a fixed bound; overflow drops the oldest entry and never blocks ingest. | planned: bounds tests per resource in `../architecture/runtime.md` |
| I10 | Payload and attribute values are never written to disk or to logs. | planned: log capture test on ingest of a payload with a marker string |
| I11 | The UI renders payload content as text, never as HTML. | planned: e2e test with an HTML/JS payload |
| I12 | Durations are computed within one span (one clock). Offsets between spans from different processes are shown as received, and a child that starts before its parent is flagged. | planned: UI waterfall tests |
