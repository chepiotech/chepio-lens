# Security

Status: design (2026-10-23). The MVP is a local development tool without authentication (ADR-0003). Payloads are
the main risk: they carry passwords, tokens and personal data (ADR-0004).

## Trust boundaries

| Boundary | Data crossing it | Protection in the MVP |
|---|---|---|
| Instrumented app → collector (OTLP ingest) | Spans, app logs and actions with headers, bodies, SQL | Redaction in the SDK before export; collector bound to localhost; CORS allow-list for browsers |
| Collector → UI (UI API, SSE) | Redacted spans, logs, graph | Bound to localhost; same origin; no CORS |
| Span content → UI rendering | Attacker-controllable strings (bodies, headers, URLs, SQL) | Rendered as text only; strict Content Security Policy |
| Collector → disk and logs | — | Nothing is persisted; logs never contain attribute values |

## Rules

- **Binding.** Both listeners default to `127.0.0.1`, in the binary and in the image. In Docker the collector
  listens on `0.0.0.0` inside the container, and compose publishes the ports to `127.0.0.1` on the host only
  (`127.0.0.1:4318:4318`), in `demo/compose.yaml` and in `collector/compose.yaml`; `collector/image-smoke.sh` checks
  the published addresses.
  For a local Kubernetes cluster the development manifest explicitly binds inside the pod and uses a ClusterIP
  service with loopback port-forwarding; no Ingress, NodePort or LoadBalancer. Its NetworkPolicy restricts ingest to
  labelled app pods in the same namespace and blocks collector egress. Policy enforcement requires a supporting CNI;
  other policies are additive. This is not a deployment configuration for shared or production clusters.
- **No production, no shared networks.** Without authentication, anyone who reaches the ports reads all captured
  payloads. Production mode (auth, TLS, sampling) is a separate future decision (ADR-0003).
- **SDKs are off by default.** Without `CHEPIO_LENS_ENDPOINT` (or an empty endpoint in the browser) the SDK is a
  no-op. The Rust SDK is added behind a cargo feature and the web SDK through a dev-only dynamic import, so
  production builds do not contain it (checked for the demo web by `demo/web/src/main.test.ts`).
- **CORS on ingest.** Browsers may post telemetry only from the exact origins in `CHEPIO_LENS_CORS_ORIGINS` (default:
  the demo web on `localhost` and `127.0.0.1`); there is no wildcard. Any other `Origin` gets `403` before the body
  is read, so an arbitrary web page open in the developer's browser cannot inject telemetry into the collector.
- **Redaction cannot be switched off in the MVP.** Configuration can add keys to the defaults, not remove them.
- **UI rendering.** No `innerHTML`, no `dangerouslySetInnerHTML`, no `eval` of payload content. The canvas draws
  text with `fillText`. Every response on the UI listener sends `Content-Security-Policy: default-src 'self'; connect-src 'self'` and
  `X-Content-Type-Options: nosniff`.
- **Fixtures and tests** use fake secrets only; never record real traffic into the repository.

## Redaction defaults

Applied by both SDKs before export and again by the collector on ingest; the collector's pass covers span event
attributes with the same keys as span attributes. Event-local request/response content types take precedence for
form masking; when absent, they inherit the containing span's content types. Matching is case-insensitive. The
masked value is the string `[REDACTED]`.

| Where | Masked |
|---|---|
| Request and response headers | `authorization`, `proxy-authorization`, `cookie`, `set-cookie`, `x-api-key`, `x-auth-token`, `x-csrf-token` |
| JSON body keys, form fields, URL query parameters (key contains) | `password`, `passwd`, `secret`, `token`, `apikey`, `api_key`, `authorization`, `cookie`, `session`, `credential`, `private_key`, `card_number`, `cvv`, `iban` |
| SQL | `db.query.text` is kept: parameterized queries contain placeholders, not values. Parameter values are never captured: they have no names, so key-based masking could not protect them (ADR-0010) |

### Body capture

Outbound Tower instrumentation preserves the request body type: request headers and declared size are recorded,
and the server layer captures request text. Response text follows the same redaction and size limits as below.
Native gRPC captures neither message content nor arbitrary request/response metadata, even for `application/grpc+json`.
Only bounded method names, protocol status, endpoint and sizes are recorded; `grpc-message`, status details, binary
metadata and transport error strings are never exported. Unknown method paths containing query/escape characters
or over 512 bytes are omitted. See ADR-0015.

- Bodies are captured as text only for `application/json`, `*+json`, `application/x-www-form-urlencoded` and
  `text/*`; for other content types only the size and the content-type header are recorded.
- Redact whole, then cut: an SDK keeps at most 256 KiB of a body, masks it (JSON keys, form fields; plain text is kept
  as is), then cuts it to `CHEPIO_LENS_BODY_LIMIT` at a character boundary and sets `lens.http.*.body.truncated`.
  Cutting first would leave invalid JSON whose keys could not be masked. A body over 256 KiB, or one not read to the
  end, is recorded by size and the truncation flag only, without text.
- If the collector's attribute limit cuts a request or response body from an exporter, the ingest redaction pass
  replaces the entire body with `[REDACTED]` and retains its truncation marker. This applies to span and event
  attributes: a cut JSON prefix cannot be masked reliably by key. Bodies already masked and shortened by the SDK
  keep their normal SDK truncation markers and are unaffected when within the collector's limit.
- A body that is not valid JSON despite its content type is captured as text without key-based masking and marked in
  the inspector.

### App logs and actions

Log attributes and structured OTLP bodies are masked recursively by key before formatting or shortening; HTTP
header/body/URL attributes use the same rules as spans. The Rust bridge masks named tracing fields and valid JSON
text fields; browser console arguments use a bounded serializer that masks keys without invoking getters or
`toJSON`. Already-formatted free text is not parsed as arbitrary object/debug syntax. Collector-side truncation
marks the record; shortened data cannot undo masking.

Browser action labels omit form values; navigation omits query strings and fragments. Accessible labels and button
text are still free text and should not contain secrets. The original browser console output is unchanged and can
contain values the application chose to print; redaction applies to exported telemetry. Collector diagnostics never
repeat accepted or rejected log payloads. Log details are React text, including strings that resemble HTML.

## Container dependency evidence

The runtime image contains only the static collector, musl's license and build evidence; it has no shell or package
manager (ADR-0017). `collector/image/verify.py` checks the actual exported filesystem and binary. Vulnerability
checks must cover `/usr/share/chepio-lens-build/native.cdx.json` and `Cargo.lock` in addition to the image itself:
an empty package scan of scratch does not establish that statically linked dependencies are safe. The build binds
this evidence to the binary hash and verifies the linked system libc. Exact Rust compiler metadata records the
source of the standard library and libunwind.

## Known gaps (accepted for the MVP)

- Secrets inside free text (e.g. a token inside a log message body or an `exception` event's message) are not
  detected.
- SQL with values inlined into the query text (no placeholders) shows those values.
- No integrity or authenticity of ingested telemetry: any local process can send fake spans or logs.
