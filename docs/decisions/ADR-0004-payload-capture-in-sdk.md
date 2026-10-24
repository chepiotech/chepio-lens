# ADR-0004: Payloads are captured and redacted in the SDK

## Status
Accepted

## Date
2026-10-23

## Context
The owner wants to see what each request carries: headers, bodies and SQL. OpenTelemetry instrumentation does not
record bodies, by design. Somewhere we must capture them and protect secrets inside them.

## Decision
- SDKs capture request and response headers and bodies as span attributes (`http.request.header.*`,
  `lens.http.*.body`; see `../architecture/interfaces.md`), with a size limit (default 16 KiB) and a content-type
  allow-list.
- SDKs redact before export using the defaults in `../architecture/security.md`. The collector applies the same
  redaction again on ingest, which also covers spans from stock OpenTelemetry exporters.
- SQL text is kept (parameterized queries hold placeholders). SQL parameter values are opt-in.
- Redaction cannot be switched off in the MVP; configuration can only add keys.

## Rationale
- Redacting inside the app keeps secrets from ever leaving the process: the strongest point to enforce it.
- The second pass in the collector is defense in depth for spans that did not come through our SDK.
- Span attributes need no second transport (ADR-0001).

## Alternatives considered
- **Redact only in the collector**: simpler SDKs, but secrets travel over the network and sit in collector memory
  before masking. Rejected.
- **Separate payload channel** (e.g. a log stream joined by trace id): no attribute size pressure, but a second
  protocol to build and correlate. Rejected for the MVP.
- **Capture bodies through a proxy** in front of the backend: no SDK changes, but no access to SQL and harder setup.
  Rejected.

## Consequences
- Easier: one rule set, enforced at the source.
- Harder: redaction exists in Rust and TypeScript; shared test vectors keep them equal. Reading a response body in
  the browser must not consume the app's stream (the SDK reads a clone).
- Risk: key-based masking misses secrets inside free text and values inlined into SQL (accepted gaps in
  `../architecture/security.md`).

## Validation / fitness criteria
- Shared vectors in `conventions/testdata/` pass in both languages.
- An end-to-end test logs into the demo app and asserts the password never reaches the collector unmasked.

## Reconsider when
- Bodies larger than the attribute limits are needed regularly → separate payload channel.
- Production mode is introduced (ADR-0003) → review defaults and sampling.

## References
- `../architecture/security.md`, `../domain/invariants.md` (I2)
