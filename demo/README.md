# Demo app

The full-stack app that chepio-lens instruments and its end-to-end tests drive: a React page, a Rust API (axum,
sqlx) and Postgres. In compose both report to the collector: the API is built with the cargo feature `lens`, and the
web page loads the web SDK in development when `VITE_CHEPIO_LENS_ENDPOINT` is set. Without them there is no
telemetry, and production builds of the web page never contain the SDK.

## Run

```sh
docker compose -f demo/compose.yaml up --build
```

Open http://localhost:5173 for the demo and http://localhost:4320 for its live map. Every port is published on
`127.0.0.1` only:

| Service | Host address | Notes |
|---|---|---|
| web | `127.0.0.1:5173` | Vite dev server; proxies `/api` to the API, so the browser stays on one origin and the API needs no CORS. Its origin is in the collector's default CORS list |
| api | `127.0.0.1:8080` | Runs migrations on startup |
| db | `127.0.0.1:55432` | Postgres 17, user `demo`, password `demo`, database `demo` |
| collector | `127.0.0.1:4318` (OTLP), `127.0.0.1:4320` (map) | chepio-lens, built from `collector/Dockerfile` with the UI embedded |

## API

| Endpoint | Behavior |
|---|---|
| `GET /api/health` | `200 {"status":"ok"}` |
| `GET /api/notes` | Newest 100 notes |
| `POST /api/notes`, `PUT /api/notes/{id}` | Body `{"text": "..."}`, 1–1000 characters after trimming; otherwise `422` |
| `GET /api/notes/{id}`, `DELETE /api/notes/{id}` | `404` for an unknown id |
| `POST /api/login` | Body `{"username": "demo", "password": "demo-password"}` → `{"token": "demo-session-token"}`, else `401`. Fake credentials: the password and token are what chepio-lens must redact |
| `GET /api/slow` | Sleeps 300–800 ms, returns `{"slept_ms": n}` |
| `GET /api/fail` | Queries a missing table and returns `500` |

Request bodies are limited to 64 KiB.

## End-to-end check

`demo/e2e/backend-db.sh` starts the stack, calls the API and checks that the map shows `demo-api → postgres` with the
right number of calls within 2 s. `--no-build` skips the image build, `--down` stops the stack afterwards.

With the stack up, the browser test adds a note in the demo and checks that the map shows `demo-web → demo-api →
postgresql demo` within 2 s and animates the request once (Chromium via Playwright):

```sh
pnpm --filter demo-e2e exec playwright install chromium   # once
pnpm --filter demo-e2e e2e
```

The suite also ingests synthetic failures and successes and checks the canvas arrow color and last-call duration,
including a delayed older failure. This regression can run alone with `--grep 'arrow recovers'`; a custom Playwright
config may set `use.baseURL` for the UI and `metadata.otlpUrl` for ingest (defaults are the compose ports above).

`request-inspector.spec.ts` covers the logs filters, edge selection, payload masking and literal HTML rendering,
waterfall clock skew, SQL and errors, live pause/resume/reconnect, docking and resizing, pagination bounds, late
search responses and failed/evicted loads. Tests run with one worker because they share and reset the collector.

On the map, click **Logs** to see the activity stream, or click an arrow to filter it to that edge. Select a line
to inspect its trace and span. The panel can dock on the right or at the bottom; drag its divider or use the arrow
keys while the divider is focused to resize it. Scrolling up pauses live updates; **Resume live** returns to the
newest entries. Edge statistics include the session totals, approximate percentiles and calls per route.

`pnpm --filter demo-e2e perf` measures the map's frame time on a synthetic graph of the target size; it starts the UI
dev server itself and needs no stack.

## Run without Docker

```sh
docker compose -f demo/compose.yaml up -d db
DATABASE_URL=postgres://demo:demo@127.0.0.1:55432/demo cargo run -p demo-api
pnpm --filter demo-web dev
```

`DEMO_API_ADDR` sets the API listener (default `127.0.0.1:8080`); `DEMO_API_URL` sets the web proxy target.

## Report to chepio-lens

The API reports to a collector when built with the cargo feature `lens` and `CHEPIO_LENS_ENDPOINT` is set:

```sh
cargo run -p chepio-lens-collector &
CHEPIO_LENS_ENDPOINT=http://localhost:4318 DATABASE_URL=postgres://demo:demo@127.0.0.1:55432/demo \
  cargo run -p demo-api --features lens
```

The web page reports when the dev server gets `VITE_CHEPIO_LENS_ENDPOINT` (`src/main.tsx` imports the SDK only in
development; `src/main.test.ts` checks that production builds leave it out):

```sh
VITE_CHEPIO_LENS_ENDPOINT=http://localhost:4318 pnpm --filter demo-web dev
```

Then `curl http://localhost:4320/api/graph` shows `demo-api` and its database.
