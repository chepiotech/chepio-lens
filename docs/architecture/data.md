# Data

Status: collector model implemented, with span events, app/action logs and per-route edge counters (2026-10-25). The collector has no database: everything lives in a bounded
in-memory store and is lost on restart (ADR-0005). Bounds and eviction numbers are in `runtime.md`; identity and derivation rules are in
`../domain/invariants.md`.

## Model

```
Request (one trace) 1 ──── * Span ──── * Attribute
                                │  └──── * Event ──── * Attribute
                    derives     ├──────▶ Log entry (one line per stored span)
                                ▼
Node * ──── Edge ──── * Node        (graph, aggregated over all requests; Edge 1 ── * Route stats)
```

| Entity | Key | Fields | Notes |
|---|---|---|---|
| Span | `trace_id` (16 bytes) + `span_id` (8 bytes) | `parent_span_id`, `service`, `kind` (server, client, internal, producer, consumer), `name`, `start_ns`, `end_ns`, `status` (unset, ok, error + message), normalized attributes, truncated attribute keys, events (name, time, normalized attributes, their own truncated attribute keys) | Normalized at ingest: legacy semconv names mapped to stable ones, values redacted. At most 32 events per span; when more arrive, `events` is added to the truncated keys. Raw (pre-normalization) attributes are not kept |
| Request | `trace_id` | root span, method, route, status code, duration, services touched, error flag, span count, `has_root`, hops (edge, offset, duration, packet: protocol, operation, body kinds, status, error) | Summary of a trace, updated as spans arrive; the detail adds every span (`GET /api/requests/{trace_id}`) |
| Log entry | (`time_ns`, `seq`); `seq` is the arrival number | trace and span ids, parent span id, duration, layer, kind, service, node ids, one-line text (at most 300 characters), status code, error flag | One per stored span, built at ingest from already-redacted values. Layer: `database` for a client span with `db.system.name`, `frontend` for spans of a frontend node, `backend` otherwise. Kind: `query` (database), `request` (server span, or a browser fetch), `call` (backend client span to another service or host), `span` (anything else). Text: SQL on one line for queries, `<method> <url without scheme>` for client calls, the span name otherwise |
| App/action record | Log entry cursor | optional trace/span ids, timestamp, service, severity, body, structured attributes, truncation flag | OTLP log; adds a `log` or `action` entry with no duration. A service node may be observed, but no request or edge is invented. Error/fatal levels set the entry error flag |
| Activity | `action:<lens.action.id>` or `trace:<trace_id>` (ADR-0016) | origin (action or request), title, time and the service whose clock it is in, duration in that clock, listed traces (at most 64, more counted), layers, services, nodes, line count, error flag, status code | A user action with every trace its fetches started, a trace without an action, or an action that started nothing; updated at ingest from the same entries as the log. A trace that arrived first is merged into its action. Steps are derived on read from stored spans and records in call-tree order (I13); an app log outside any request belongs to no activity |
| Node | stable string id (see invariants) | `kind` (frontend, service, database, external), label, details (database system, address, namespace), optional declared metadata (technologies, pages, microfrontends), `first_seen`, `last_seen` | Created on first span or log resource that implies it; metadata changes produce a node update (`interfaces.md`) |
| Edge | (`from`, `to`, `protocol`) | `protocol` (http, db), latest call result and exact caller duration, totals (count, errors), latency summary (p50, p95), rate over the last 60 s, `last_seen`, route stats | Updated incrementally on every linked span. Latest call is ordered by caller completion timestamp, then trace/span ids, independently of arrival order. p50/p95 come from a fixed log-scale histogram (4 buckets per doubling, at most ~19% above the true value); the rate from 60 one-second slots |
| Route stats | edge + route label | count, errors, mean and max duration | The callee's qualified gRPC method (including a bounded original name when unrecognized), or HTTP route: `<method> <http.route>` of the server span (else its name), `<db.operation.name> <db.collection.name>` of a query (else its name), `<method> <path>` of a call to an external node. At most 16 routes per edge; further calls are counted under `(other routes)`. No histogram, to keep edges small |

## Storage

- Requests and their spans: a ring buffer bounded by request count and by total bytes; the oldest request is evicted
  first.
- Activities: an index ordered by time, then arrival, bounded by count; the oldest is dropped. Steps of an activity
  whose spans or records were already evicted are missing; the summary stays until the activity itself is dropped.
- Log: entries ordered by time, then arrival, bounded by count and estimated retained bytes; the oldest by time is dropped. Independent of request
  eviction, so a line can outlive its request (the inspector then answers `404`).
- Graph (nodes and edges): kept for the collector's lifetime, independent of request eviction, bounded by node and
  edge count. `POST /api/reset` clears the graph, the requests and the log.
- Pending client spans waiting for their server-side child: a bounded map with a time limit (link window).
- Normalized node metadata is shared through `Arc` by the records in one OTLP resource and its service node.
  Retained span and log byte estimates conservatively count metadata per record, so sharing cannot bypass storage
  bounds. Graph identity and linking do not depend on metadata.
- Nothing is written to disk. Captured app logs live only in the bounded store; their values never appear in the collector's own diagnostic logs.

## Serialization and precision

- Times: nanoseconds since the Unix epoch as `u64` (OTLP `fixed64`). The UI API sends them as decimal strings,
  because JavaScript numbers lose precision above 2^53.
- IDs: lowercase hex strings in the UI API (32 chars for trace, 16 for span), as in W3C Trace Context.
- Attribute values keep their OTLP type (string, bool, int, double, array, map). OTLP JSON encodes 64-bit ints as strings;
  the decoder accepts both forms.

## Retention

Session-only. A request disappears when it is evicted by the bounds or when the collector restarts; a log line when
the log's bound drops it. The graph disappears on restart or reset. Persistence across restarts is out of scope for the MVP (ADR-0005).
