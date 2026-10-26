# ADR-0015: Trace outbound HTTP and gRPC with one Tower layer

## Status
Accepted

## Date
2026-10-26

## Context
The real integration target uses hyper clients and tonic channels. Server-only instrumentation loses parentage
between services. gRPC calls may return HTTP 200 and fail in their final trailers.

## Decision
Add `Lens::client_layer()` over `tower::Service<Request<B>>`. It injects W3C trace context and records a client span.
Keep the request body type unchanged so it wraps tonic channels and hyper clients directly. Capture HTTP request
headers and declared size, and HTTP response bodies; the callee's server layer captures the request body.
The existing `http_layer()` also instruments tonic servers. Both layers detect native gRPC by content type and
observe status in headers or trailers. Responses preserve frames and body errors. Each call ends once at completion,
failure or cancellation; polling streaming bodies restores the call's context.

Use RPC semantic conventions 1.44.0 (release candidate): `rpc.system.name`, `rpc.method`,
`rpc.response.status_code`. Configured recognized methods use their qualified name; otherwise `rpc.method` is
`_OTHER`, with a syntactically valid path (at most 512 bytes) in `rpc.method_original`. Legacy RPC attributes are
normalized on ingest. A separate nullable packet `rpc_status` keeps gRPC outcomes distinct from HTTP status.
gRPC uses the existing HTTP transport edges and a distinct packet kind.

## Rationale
Tower is already shared by both clients. No protocol-specific runtime dependency, transport replacement, background
task or additional queue is necessary. Reading final trailers covers unary and streaming RPCs.

## Alternatives considered
- A tonic interceptor only: cannot observe response trailers or wrap hyper.
- Replace every client's body type: incompatible with tonic's fixed request body.
- Capture protobuf and arbitrary metadata: cannot redact application fields without descriptors; omitted.

## Consequences
Outbound HTTP request bodies are available from an instrumented callee, not the client. gRPC payloads, arbitrary
metadata and error messages are not exported; only protocol metadata and status are recorded. Client endpoints may
need explicit configuration when a channel supplies its URI after the layer. Existing transports retain TLS,
timeouts, readiness, retries and cancellation ownership. Web SDK fetch instrumentation is unchanged.

## Validation / fitness criteria
SDK tests cover context propagation, independent concurrent calls, trailers, failure, cancellation and disabled mode;
collector fixtures and UI tests cover gRPC status and successful calls after errors. Real tonic/hyper checks prove
the generic layer fits their transports. Existing redaction and HTTP suites remain green.

## Reconsider when
A supported client does not use Tower, protobuf inspection is required, or RPC semantic conventions stabilize with
incompatible names. Revisit request capture only if client-side request payloads are required without a callee SDK.

## References
- [RPC spans](https://opentelemetry.io/docs/specs/semconv/rpc/rpc-spans/)
- [gRPC conventions](https://opentelemetry.io/docs/specs/semconv/rpc/grpc/)
- [tonic GrpcService](https://docs.rs/tonic/0.14.6/tonic/client/trait.GrpcService.html)
