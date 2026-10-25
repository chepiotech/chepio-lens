# Security

Status: design (2026-10-23). The MVP is a local development tool without authentication (ADR-0003). Payloads are
the main risk: they carry passwords, tokens and personal data (ADR-0004).

## Trust boundaries

| Boundary | Data crossing it | Protection in the MVP |
|---|---|---|
| Instrumented app → collector (OTLP ingest) | Spans with headers, bodies, SQL | Redaction in the SDK before export; collector bound to localhost; CORS allow-list for browsers |
| Collector → UI (UI API, SSE) | Redacted spans, graph | Bound to localhost; same origin; no CORS |
| Span content → UI rendering | Attacker-controllable strings (bodies, headers, URLs, SQL) | Rendered as text only; strict Content Security Policy |
| Collector → disk and logs | — | Nothing is persisted; logs never contain attribute values |

## Rules

- **Binding.** Both listeners default to `127.0.0.1`. In Docker the collector listens on `0.0.0.0` inside the
  container, and compose publishes the ports to `127.0.0.1` on the host only (`127.0.0.1:4318:4318`).
- **No production, no shared networks.** Without authentication, anyone who reaches the ports reads all captured
  payloads. Production mode (auth, TLS, sampling) is a separate future decision (ADR-0003).
- **SDKs are off by default.** Without `CHEPIO_LENS_ENDPOINT` (or an empty endpoint in the browser) the SDK is a
  no-op. The Rust SDK is added behind a cargo feature and the web SDK through a dev-only dynamic import, so
  production builds do not contain it (checked for the demo web by `demo/web/src/main.test.ts`).
- **CORS on ingest.** Browsers may post spans only from the exact origins in `CHEPIO_LENS_CORS_ORIGINS` (default:
  the demo web on `localhost` and `127.0.0.1`); there is no wildcard. Any other `Origin` gets `403` before the body
  is read, so an arbitrary web page open in the developer's browser cannot inject spans into the map.
- **Redaction cannot be switched off in the MVP.** Configuration can add keys to the defaults, not remove them.
- **UI rendering.** No `innerHTML`, no `dangerouslySetInnerHTML`, no `eval` of payload content. The canvas draws
  text with `fillText`. Every response on the UI listener sends `Content-Security-Policy: default-src 'self'; connect-src 'self'` and
  `X-Content-Type-Options: nosniff`.
- **Fixtures and tests** use fake secrets only; never record real traffic into the repository.

## Redaction defaults

Applied by both SDKs before export and again by the collector on ingest. Matching is case-insensitive. The masked
value is the string `[REDACTED]`.

| Where | Masked |
|---|---|
| Request and response headers | `authorization`, `proxy-authorization`, `cookie`, `set-cookie`, `x-api-key`, `x-auth-token`, `x-csrf-token` |
| JSON body keys, form fields, URL query parameters (key contains) | `password`, `passwd`, `secret`, `token`, `apikey`, `api_key`, `authorization`, `cookie`, `session`, `credential`, `private_key`, `card_number`, `cvv`, `iban` |
| SQL | `db.query.text` is kept: parameterized queries contain placeholders, not values. Parameter values are captured only when `CHEPIO_LENS_CAPTURE_SQL_PARAMS=true`; they have no names, so key-based masking cannot protect them |

Bodies are captured only for `application/json`, `application/x-www-form-urlencoded` and `text/*`; for other
content types only the size and content type are recorded. A body that is not valid JSON despite its content type is
captured as text without key-based masking and marked in the inspector.

## Known gaps (accepted for the MVP)

- Secrets inside free text (e.g. a token inside a log message body) are not detected.
- SQL with values inlined into the query text (no placeholders) shows those values.
- No integrity or authenticity of ingested spans: any local process can send fake spans.
