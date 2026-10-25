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

- If the browser calls your API on another origin (not through the Vite proxy), add
  `propagateTo: [/^http:\/\/localhost:8080\//]` to `initLens`, and let your API accept the `traceparent` header in its
  CORS policy. Without it the frontend and the API show up unconnected.
- Next.js: only the browser part is covered. Add `transpilePackages: ['chepio-lens-web']` to `next.config`, call the
  same code from a client component, and use `NEXT_PUBLIC_CHEPIO_LENS_ENDPOINT`.

## 4. Check it works

Use your app. Within about two seconds the map shows `my-web → my-api → postgresql …`, each request travels along it,
and **Logs** lists the requests, queries, your log lines and clicks. Click a line to inspect its headers, bodies and
SQL. `curl -s http://localhost:4320/api/stats` counts what arrived.

## Troubleshooting

| You see | Likely cause |
|---|---|
| Nothing at all | The endpoint variable is not set where the app runs, or the collector is not running (`curl http://localhost:4320/healthz`) |
| Backend and database, no frontend | CORS: the browser console shows `403` for `/v1/traces`; add your origin to `CHEPIO_LENS_CORS_ORIGINS`. Or the frontend runs a production build |
| Frontend and backend, no arrow between them | `traceparent` is not sent: add `propagateTo` for a cross-origin API and allow the header in the API's CORS |
| `cargo` cannot fetch `chepio-lens-sdk` (`failed to resolve address`) | Your git config rewrites GitHub URLs to an SSH alias that Cargo's built-in git does not know: build with `CARGO_NET_GIT_FETCH_WITH_CLI=true`, or set `net.git-fetch-with-cli = true` in `~/.cargo/config.toml` |
| No database node | The backend prints `chepio-lens: database spans are off …`: add `lens.tracing_layer()` to your subscriber and allow `sqlx::query=debug` |
| A secret in a body or log | Add its key with `CHEPIO_LENS_REDACT_KEYS` (backend) and `redactKeys` (frontend); free-text messages are not masked |
