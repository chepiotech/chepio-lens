# Connect a project

This guide connects an app to chepio-lens on your own machine: a React frontend built with Vite and a Rust backend
(axum 0.8, sqlx 0.9 with Postgres). It takes about 15 minutes; most of that is the first build of your backend with
the SDK. chepio-lens is for local development only: it has no authentication and shows request payloads.

Versions below use `v0.1.0`. Before the first release, use a commit of `main` instead, as each step notes.

## 1. Run the collector

Copy the `chepio-lens` service from [`collector/compose.yaml`](../../collector/compose.yaml) into your project's
compose file, or run it on its own from a clone:

```sh
CHEPIO_LENS_CORS_ORIGINS=http://localhost:5173 docker compose -f collector/compose.yaml up -d
```

- `CHEPIO_LENS_CORS_ORIGINS` lists the origins your frontend is served from during development, comma-separated
  (`http://localhost:3000` for Next.js). Spans from any other origin are refused with `403`.
- Before `v0.1.0` there is no published image: build one with
  `docker build -f collector/Dockerfile -t chepio-lens:dev https://github.com/chepiotech/chepio-lens.git#main` and set
  `CHEPIO_LENS_IMAGE=chepio-lens:dev`.
- Without Docker, install it from a clone (README, "Run the collector") and start `chepio-lens`.

Open http://localhost:4320: the map says it is waiting for spans.
The image has no shell. Use HTTP for health checks; projects that scan dependencies should also scan the native
inventory and Cargo.lock under `/usr/share/chepio-lens-build/` (see [image evidence](../architecture/security.md#container-dependency-evidence)).

## 2. Connect the backend

Add the SDK behind a cargo feature, so builds without it contain nothing of chepio-lens:

```toml
[features]
lens = ["dep:chepio-lens-sdk"]

[dependencies]
chepio-lens-sdk = { git = "https://github.com/chepiotech/chepio-lens", tag = "v0.1.0", optional = true }
```

Before `v0.1.0`, replace `tag = "v0.1.0"` with `rev = "<commit of main>"`. In `main`, before the database pool and
around your router:

```rust
#[cfg(feature = "lens")]
let lens = chepio_lens_sdk::init("my-api")? // a no-op unless CHEPIO_LENS_ENDPOINT is set
    .with_database(chepio_lens_sdk::Database::postgres_url(&database_url));
#[cfg(feature = "lens")]
lens.install_tracing()?;
// … build the pool and the router …
#[cfg(feature = "lens")]
let router = router.layer(lens.http_layer());
// … serve; after the server stops:
#[cfg(feature = "lens")]
lens.shutdown();
```

Run it with `CHEPIO_LENS_ENDPOINT=http://localhost:4318 cargo run --features lens`. In a container on the same compose
network as the collector, the endpoint is `http://chepio-lens:4318`.

- If your app already sets a tracing subscriber, `install_tracing` fails: add `lens.tracing_layer()` to your subscriber
  instead, and let `sqlx::query=debug` through any level filter, or there are no database spans.
- `install_tracing` exports your `tracing` events at `INFO` and above as log lines.
- `CHEPIO_LENS_CAPTURE_BODIES=false` stops body capture; `CHEPIO_LENS_REDACT_KEYS=tenant,ssn` masks more keys
  (defaults: [security](../architecture/security.md)).

### Calls to other services (hyper and tonic)

Wrap the client once where you build it. Keep the SDK initialization and wrappers behind your `lens` feature:

```rust
use tower::{Layer, ServiceExt};

// `http_client` is your existing hyper_util::client::legacy::Client.
let http_client = lens.client_layer().layer(http_client);
let response = http_client.clone().oneshot(request).await?;

// `channel` is your existing tonic Channel, with its TLS, deadlines and limits already configured.
let channel = lens.client_layer()
    .with_endpoint("https://identity:50051".parse()?)
    .with_rpc_methods(&["school.Identity/GetUser"])
    .layer(channel);
let identity = IdentityClient::new(channel);
```

Concrete client types become `chepio_lens_sdk::ClientService<OriginalClient>` (or `ClientService<tonic::transport::Channel>`).
Use a feature-dependent type alias where your application stores these types. `with_endpoint` is telemetry metadata;
use the same endpoint as the channel, never a browser Host header. It does not change TLS or route the request.

On each tonic server, use the same server layer as for axum:

```rust
tonic::transport::Server::builder()
    .layer(lens.http_layer().with_rpc_methods(&["school.Identity/GetUser"]))
    .add_service(identity_server)
    .serve(address).await?;
```

Run calls inside the incoming request's context. When explicitly spawning a task, carry the context with
`opentelemetry::context::FutureExt::with_context`; unrelated tasks otherwise start independent traces. Existing
clients' retries and timeouts remain their responsibility. gRPC status includes final trailers, so HTTP 200 with an
RPC error is shown as failed. gRPC payloads and arbitrary metadata are not captured. HTTP outgoing request bodies
are captured by the instrumented callee; the client records headers, declared size and the response body.

The optional static method list contains the methods recognized by your generated service. Without it the span is
named `grpc`, and the bounded original method is still available on the map and in the inspector.

## 3. Connect the frontend

Install the SDK as a development dependency:

```sh
npm install -D https://github.com/chepiotech/chepio-lens/releases/download/v0.1.0/chepio-lens-web-0.1.0.tgz
# pnpm add -D <the same URL>, or yarn add -D <the same URL>
```

Before `v0.1.0`, with pnpm or Yarn (npm cannot install a folder of a git repository):
`pnpm add -D "chepio-lens-web@github:chepiotech/chepio-lens#<commit of main>&path:/sdk/web"`.

Load it only in development, before the first render, in your entry file (`src/main.tsx`):

```ts
if (import.meta.env.DEV && import.meta.env.VITE_CHEPIO_LENS_ENDPOINT) {
  try {
    const { initLens } = await import('chepio-lens-web')
    initLens({ serviceName: 'my-web', endpoint: import.meta.env.VITE_CHEPIO_LENS_ENDPOINT })
  } catch (error) {
    console.warn('chepio-lens: tracing is off', error)
  }
}
```

and add `VITE_CHEPIO_LENS_ENDPOINT=http://localhost:4318` to `.env.development.local`. Production builds leave the SDK
out.

To populate map cards, pass `node` to `initLens` with your frontend frameworks, page paths and optional
microfrontends. For Rust, use `Config.node` with `init_with`, or `CHEPIO_LENS_NODE_METADATA` when keeping `init`.
See the [SDK settings and examples](../architecture/interfaces.md#declared-node-metadata). Backend endpoints
come from observed calls. Redis appears as a cache when Redis database client spans arrive; naming it in the
technology list does not create a connection. **Settings → General → Example map** in the collector UI shows the richer layout with
microfrontends and Redis using illustrative data.

- If the browser calls your API on another origin (not through the Vite proxy), add
  `propagateTo: [/^http:\/\/localhost:8080\//]` to `initLens`, and let your API accept the `traceparent` header in its
  CORS policy. Without it the frontend and the API show up unconnected.
- Next.js: only the browser part is covered. Add `transpilePackages: ['chepio-lens-web']` to `next.config`, call the
  same code from a client component, and use `NEXT_PUBLIC_CHEPIO_LENS_ENDPOINT`.

## 4. Check it works

Use your app. Within about two seconds the map shows `my-web → my-api → postgresql …`, each request travels along it,
and the **Console** icon at the top left opens requests, queries, your log lines and clicks. Click a line to inspect
its headers, bodies and SQL. The **Settings** icon at the top right opens connection status, session reset and map
options. `curl -s http://localhost:4320/api/stats` counts what arrived.

## Local Kubernetes / kind

Use this only in a local cluster dedicated to your development app. Copy
[`collector/kubernetes.yaml`](../../collector/kubernetes.yaml) into its local overlay, in the app's namespace.
Set `CHEPIO_LENS_CORS_ORIGINS` there to the actual browser origin (for example `http://localhost:18088`). The pod
explicitly binds its container interfaces; binary and image defaults remain loopback. The manifest uses one replica,
a ClusterIP service and no external ingress. A restart loses the in-memory session.

Before the first release, build and load the image, then change the copied manifest's image to `chepio-lens:dev`:

```sh
docker build -f collector/Dockerfile -t chepio-lens:dev .
kind load docker-image chepio-lens:dev --name my-app
kubectl --context kind-my-app -n my-app apply -f path/to/copied/chepio-lens.yaml
kubectl --context kind-my-app -n my-app rollout status deployment/chepio-lens
kubectl --context kind-my-app -n my-app port-forward --address 127.0.0.1 service/chepio-lens 4318:4318 4320:4320
```

Use your cluster name, namespace and copied file path. Keep the port-forward running; stop any other local collector
using those ports first. Backend pods use `CHEPIO_LENS_ENDPOINT=http://chepio-lens:4318`; the browser uses
`http://localhost:4318`, and the map is at `http://localhost:4320`.

Set `chepio-lens-client: "true"` on the instrumented services' **pod template** labels. The supplied NetworkPolicy
allows their ingest in the same namespace. If your app already restricts egress, extend its existing policy with:

```yaml
# One additional item under spec.egress of the app's existing policy.
- to:
    - podSelector:
        matchLabels:
          app.kubernetes.io/name: chepio-lens
  ports:
    - protocol: TCP
      port: 4318
```

Keep the app's existing DNS, database and service rules. Do not add an egress-isolating policy to previously
unrestricted app pods without also describing their other required destinations. The collector needs no egress.
NetworkPolicy only works with a supporting network plugin; a default kind cluster may not enforce it. Policies are
additive: another broad allow rule can widen access. Check the cluster's effective policies and keep it private.
See [Kubernetes network policies](https://kubernetes.io/docs/concepts/services-networking/network-policies/) and
[port forwarding](https://kubernetes.io/docs/tasks/access-application-cluster/port-forward-access-application-cluster/).

Validate without creating resources: `kubectl --context kind-my-app -n my-app create --dry-run=client --validate=true -f path/to/copied/chepio-lens.yaml -o json` (API discovery requires access to the local cluster).
Then check `/healthz`, use the app and verify `browser → gateway → service → database` on the map. If a service is
missing, check its endpoint, pod labels and egress policy; the browser cannot use the cluster's internal DNS name.

## Troubleshooting

| You see | Likely cause |
|---|---|
| Nothing at all | The endpoint variable is not set where the app runs, or the collector is not running (`curl http://localhost:4320/healthz`) |
| Backend and database, no frontend | CORS: the browser console shows `403` for `/v1/traces`; add your origin to `CHEPIO_LENS_CORS_ORIGINS`. Or the frontend runs a production build |
| Frontend and backend, no arrow between them | `traceparent` is not sent: add `propagateTo` for a cross-origin API and allow the header in the API's CORS |
| `cargo` cannot fetch `chepio-lens-sdk` (`failed to resolve address`) | Your git config rewrites GitHub URLs to an SSH alias that Cargo's built-in git does not know: build with `CARGO_NET_GIT_FETCH_WITH_CLI=true`, or set `net.git-fetch-with-cli = true` in `~/.cargo/config.toml` |
| No database node | The backend prints `chepio-lens: database spans are off …`: add `lens.tracing_layer()` to your subscriber and allow `sqlx::query=debug` |
| A secret in a body or log | Add its key with `CHEPIO_LENS_REDACT_KEYS` (backend) and `redactKeys` (frontend); free-text messages are not masked |
