# Data

Status: collector model implemented (2026-10-24). The collector has no database: everything lives in a bounded
in-memory store and is lost on restart (ADR-0005). Bounds and eviction numbers are in `runtime.md`; identity and derivation rules are in
`../domain/invariants.md`.

## Model

```
Request (one trace) 1 ──── * Span ──── * Attribute
                                │
                    derives     ▼
Node * ──── Edge ──── * Node        (graph, aggregated over all requests)
```

| Entity | Key | Fields | Notes |
|---|---|---|---|
| Span | `trace_id` (16 bytes) + `span_id` (8 bytes) | `parent_span_id`, `service`, `kind` (server, client, internal, producer, consumer), `name`, `start_ns`, `end_ns`, `status` (unset, ok, error + message), normalized attributes, raw attributes, events | Normalized at ingest: legacy semconv names mapped to stable ones, values redacted. Raw attributes and events are not kept yet |
| Request | `trace_id` | root span, method, route, status code, duration, services touched, error flag, span count | Summary of a trace, updated as spans arrive |
| Node | stable string id (see invariants) | `kind` (frontend, service, database, external), label, details (database system, address, namespace), `first_seen`, `last_seen` | Created on first span that implies it |
| Edge | (`from`, `to`, `protocol`) | `protocol` (http, db), totals (count, errors), latency summary (p50, p95), rate over the last 60 s, `last_seen`, per-route or per-operation breakdown (not built yet) | Updated incrementally on every linked span. p50/p95 come from a fixed log-scale histogram (4 buckets per doubling, at most ~19% above the true value); the rate from 60 one-second slots |

## Storage

- Requests and their spans: a ring buffer bounded by request count and by total bytes; the oldest request is evicted
  first.
- Graph (nodes and edges): kept for the collector's lifetime, independent of request eviction, bounded by node and
  edge count. `POST /api/reset` clears both the graph and the requests.
- Pending client spans waiting for their server-side child: a bounded map with a time limit (link window).
- Nothing is written to disk. Payload values never appear in logs.

## Serialization and precision

- Times: nanoseconds since the Unix epoch as `u64` (OTLP `fixed64`). The UI API sends them as decimal strings,
  because JavaScript numbers lose precision above 2^53.
- IDs: lowercase hex strings in the UI API (32 chars for trace, 16 for span), as in W3C Trace Context.
- Attribute values keep their OTLP type (string, bool, int, double, array). OTLP JSON encodes 64-bit ints as strings;
  the decoder accepts both forms.

## Retention

Session-only. A request disappears when it is evicted by the bounds or when the collector restarts. The graph
disappears on restart or reset. Persistence across restarts is out of scope for the MVP (ADR-0005).
