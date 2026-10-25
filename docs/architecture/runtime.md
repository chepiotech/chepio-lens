# Runtime

Status: design (2026-10-23). Numbers are starting defaults to be validated by the measurements in
`quality-attributes.md`; change them there and here together.

## Critical path: request in the app → visible on the map

1. The app handles a request. The SDK records spans in memory; nothing blocks the request path on export. The Rust
   SDK's server span ends when the response body has been sent (or dropped), with the captured bodies attached.
2. The SDK batch processor exports every 500 ms (OpenTelemetry's default is 5 s, too slow for a live map) or when
   512 spans are queued.
3. `POST /v1/traces` → body limit → decode (protobuf or JSON) → normalize names → redact → store → link and
   update graph → publish SSE events → respond `200`. All in one handler; no internal queue.
4. The UI applies `node` and `edge` events on the next animation frame, so counters update at once. A request's
   spans come from several processes in separate batches, each producing a `request` event; the UI animates the
   request once, 300 ms after its last event when its root span has arrived (`has_root`), else 1.2 s after it.
   Hops are placed along the call tree: a hop called inside another hop's server span is offset from that server
   span in its own clock, never by comparing clocks of different processes.

Target: p95 ≤ 2 s from request end to the map on a local machine (`quality-attributes.md`).

## Linking spans into edges

- A server span whose parent is a client span from another service creates or updates the edge
  `client.service → server.service`.
- A client span with a database system attribute creates or updates `service → database node` at once.
- A client HTTP span whose server child has not arrived waits in the pending map for the link window (10 s). After
  that it is counted on `service → external node` (`ext:<server.address>:<server.port>`). A server child that arrives
  later still links future requests, but counts already given to the external node stay there.
- Spans can arrive in any order (child before parent, browser batch after backend batch); linking checks both
  directions on arrival: a server span whose client parent has not arrived waits in its own bounded map for the same
  window, then is dropped.

## Bounds

Every buffer is bounded; on overflow the oldest entry is dropped and ingest is never blocked.

| Resource | Default bound | On overflow |
|---|---|---|
| OTLP request body | 4 MiB | `413` |
| Concurrent ingest requests | 64 | `503` + `Retry-After: 1` |
| Stored requests | 10,000 and 256 MiB of span data | Evict the oldest request |
| Spans per request | 1,000 | Drop further spans, count them in `dropped_spans` |
| Attribute value length (collector side) | 256 KiB | Cut, mark as truncated |
| Pending client spans | 10,000 | Oldest is attributed to its external node now |
| Server spans waiting for their client parent | 10,000 | Drop the oldest |
| Nodes / edges | 1,000 / 5,000 | Ignore new ones, log a warning once per minute |
| SSE clients | 16 | `503` for the 17th |
| SSE broadcast buffer | 4,096 events | Lagging client gets `resync` |
| SDK export queue (both SDKs) | 2,048 spans | Drop new spans, the app is not affected |

## Timeouts and retries

| Operation | Timeout | Retry |
|---|---|---|
| SDK export (HTTP POST) | 2 s | chepio-lens adds no retries; any built-in exporter retry on `429`/`503` must fit in the timeout (verify per SDK), then the batch is dropped. Rust SDK: opentelemetry-otlp 0.33 without its experimental retry feature, so no retries. Web SDK: the OpenTelemetry JS exporter retries `429`/`502`/`503`/`504` and network errors with backoff, but never past the 2 s deadline |
| Collector reading a request body | 10 s, then `408` | — |
| Graceful shutdown | 5 s to finish in-flight ingest and close SSE streams | — |
| UI SSE reconnect | browser `EventSource` default, then refetch `/api/graph` | Automatic |

## Failure behavior

| Failure | What the user sees | Behavior |
|---|---|---|
| Collector not running | App works normally; map is empty | SDK export fails fast, batch dropped |
| Collector overloaded | Some requests missing on the map | `503` from ingest, SDK drops after its retry |
| Malformed OTLP | Missing spans | `400`, warning logged at most once per minute per source |
| Browser blocked by CORS | No frontend node; backend still visible | Collector answers `403` and logs the rejected origin at most once per minute; documented in the connection guide |
| Missing `traceparent` on backend calls | Frontend and backend appear unlinked | Frontend client spans go to an external node after the link window |
| Clock skew between browser and server | Waterfall offsets look wrong | Durations are always per span; the UI marks a child that starts before its parent |
| Store full | Old requests disappear from the list | Graph totals are kept |
| UI tab falls behind | Brief jump of the map | `resync` → fresh snapshot |

## Concurrency model

- Tokio multi-threaded runtime. Store and graph sit behind one `std::sync::Mutex`, held only for in-memory updates
  and never across `.await`. Revisit if lock wait shows up in profiles (`quality-attributes.md`).
- Decoding protobuf or JSON happens before taking the lock.
- SSE uses `tokio::sync::broadcast`; a lagged receiver maps to the `resync` event.

## Collector self-observability

- Structured logs to stderr with no payload values.
- `GET /healthz` on the UI listener.
- Counters exposed in `GET /api/stats`: spans received, dropped (by reason), requests evicted, pending links,
  SSE clients.
