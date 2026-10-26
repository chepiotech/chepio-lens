# Demo app

The full-stack app that chepio-lens instruments and its end-to-end tests drive: a React page, a Rust API (axum,
sqlx) and Postgres. In compose both report to the collector: the API is built with the cargo feature `lens`, and the
web page loads the web SDK in development when `VITE_CHEPIO_LENS_ENDPOINT` is set. Without them there is no
telemetry, and production builds of the web page never contain the SDK.

## TaskHub architecture simulation

Open **Settings → General → TaskHub demo** in the collector UI, or append `?example=taskhub` to its URL.
For a standalone preview, run `pnpm --filter ui dev` with Node 24 and open
http://localhost:5174/?example=taskhub. This route does not need a collector, database or containers.

The map models 19 components of a TaskHub architecture: browser and external ingress, Envoy, nine application
components and six platform dependencies. Local technology logos identify the declared stack; namespaces group
the diagram. It uses the same full-canvas UI, detailed node cards, settings and dockable console as the live map.
The upper controls open the demo app, select/run a scenario, reset the simulation and return to the live map.
**Console** opens the same console as the live map: Actions and Lines, layer, node, edge, status and text
filters, and the request inspector. The simulation feeds it locally. Each scenario is one user action. Each of its
messages is one line, logged by the component that sends it: browser, Envoy, web, BFF, services, worker and
realtime gateway. A message from an opaque dependency is logged by the component it reaches. Every line names
both ends, so the node filter finds all 19 components. Exchanges with PostgreSQL, Redis and OpenSearch are in the
database layer. A scenario that cannot start is logged as a failed action. **Settings → Console** chooses the
console's left, right or bottom position. Both the app and the console overlay the canvas without resizing or
refitting it. Select a node or connection for details, use **Settings → Map → Focus a node**, and pan/zoom to
inspect. The scenarios are:

- **Create task:** project access check, task/outbox commit and HTTP 201, then independent search indexing and
  notification delivery. Only indexed tasks appear in search.
- **Add comment:** save comment/outbox, respond, then notify through RabbitMQ, worker, Redis and WebSocket.
- **Attach sample file:** upload authorization, direct browser-to-storage sample upload and ready confirmation.
- **Search tasks:** query the modeled OpenSearch projection and show matching local tasks.
- **Sign in:** synthetic Keycloak identity and Redis session; no password or token is created.
- **Open application:** web rendering, initial project data and a WebSocket connection.

DNS/CDN/WAF, cloud load balancing and all platform dependencies are opaque external services. Their cards show a
waiting indicator; details show the caller's request and returned response. Internal processing is unknown.
Every response and packet is simulated, not measured telemetry. The app performs no network or collector API
operations. Sample attachments are synthetic; it never reads or uploads a local file.

State lasts only in the current tab: at most 50 tasks, eight comments and eight files per task, 50 notifications,
160 journal entries, 400 concurrent visual packets, and in the console 50 actions, 2,000 lines and 160 steps and
spans per action (oldest dropped first). One scenario runs at a time. **Reset demo** or reload returns to the
initial task, cancels timers and clears counters, packets, pending exchanges and the console.
Task titles, comments and search queries are limited to 120, 280 and 80 characters and rendered as text.
Keyboard map controls are Left/Right (inspect), +/− (zoom), 0 (fit) and Escape (clear selection/close panel).

Verify with `pnpm --filter ui test`, `pnpm --filter ui typecheck`, `pnpm --filter ui build` and
`pnpm --filter demo-e2e map-cards`. Browser tests cover all nodes, local assets under CSP, external waiting and
responses, all scenarios, the console's actions, steps, inspector and lines from every application component,
reset/reload, keyboard controls, upper-button access, all three console docks and isolation from collector APIs
on desktop and mobile.

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
right number of calls within 2 s. `--no-build` skips the image build, `--down` stops the stack afterwards. Close
browser tabs with the demo first: when a rebuild restarts the web container, Vite reloads every open tab, and the
page load's note queries land in the count (the script says so when it sees browser requests).

With the stack up, the browser tests add a note in the demo and check that the map shows `demo-web → demo-api →
postgresql demo` within 2 s and animates the request once with its packet icons. They also log in through the demo
and check that the password and token appear nowhere the collector serves, and that markup typed into a note is shown
as text in the inspector (Chromium via Playwright):

```sh
pnpm --filter demo-e2e exec playwright install chromium   # once
pnpm --filter demo-e2e e2e
```

The suite also ingests synthetic failures and successes and checks the canvas arrow color and last-call duration,
including a delayed older failure. This regression can run alone with `--grep 'arrow recovers'`; a custom Playwright
config may set `use.baseURL` for the UI and `metadata.otlpUrl` for ingest (defaults are the compose ports above).

`request-inspector.spec.ts` covers the logs filters, edge selection, payload masking and literal HTML rendering,
waterfall clock skew, SQL and errors, live pause/resume/reconnect, docking and resizing, pagination bounds, late
search responses and failed/evicted loads. `app-logs.spec.ts` covers React click-to-fetch correlation, explicitly unlinked async actions, console severity and
structured redaction, literal HTML, live backend logs without request context and reset. Tests run with one worker
because they share and reset the collector.

On the map, click **Logs** to see the activity stream, or click an arrow to filter it to that edge. The panel opens on
**Actions**: one row per click, submit or navigation with every request it started, per request without an action
(page load, polling) and per click that started nothing. Expand a row to follow its chain there and back: the click,
the fetch sent, the backend receiving it, each SQL query and what the database answered, the response and the
browser receiving it, with headers, bodies and rows; **Open in inspector** shows a step's span. **Origin** filters
user actions or requests. **Lines** shows one row per span or log record instead. Select a line
to inspect its trace and span. **Kind** and **Level** filter app logs and actions. Browser console calls appear with
their severity; click/submit actions can open the first fetch started synchronously by their handler. A log without
a request still opens its message and attributes. Backend applications using the installed tracing layer export
their own `tracing` events; SQL query events remain query spans. The panel can dock on the right or at the bottom; drag its divider or use the arrow
keys while the divider is focused to resize it. Scrolling up pauses live updates; **Resume live** returns to the
newest entries. Edge statistics include the session totals, approximate percentiles and calls per route.

`pnpm --filter demo-e2e perf` measures the map's frame time on a synthetic graph of the target size; it starts the UI
dev server itself and needs no stack.

## SDK overhead

`demo/api/examples/sdk_overhead.rs` measures the latency the Rust SDK adds to the API. It starts the API once per
mode (without the SDK, SDK without an endpoint, exporting without bodies, with bodies, collector unreachable), sends
each the same request mix in turn, round after round, and prints latency percentiles and the difference to the API
without the SDK. It needs Postgres and, for the exporting modes, a running collector:

```sh
docker compose -f demo/compose.yaml up -d db
cargo run --release -p chepio-lens-collector &
DATABASE_URL=postgres://demo:demo@127.0.0.1:55432/demo \
  cargo run --release -p demo-api --features lens --example sdk_overhead
```

The default run takes about 9 minutes and adds 100 notes of 1000 characters, deleted at the end. `--collector`,
`--modes`, `--rate`, `--workers`, `--seconds` and `--rounds` change the setup; results go to
`docs/architecture/quality-attributes.md`.

`pnpm --filter demo-e2e sdk-overhead` measures the same for the web SDK in Chromium: a bench page
(`demo/web/sdk-overhead.html`, development only) sends the same request mix with `fetch` to a fixed in-process API of
its dev server, once per mode (without the SDK, exporting without bodies, with bodies, collector unreachable), each
slot in a fresh browser context, round after round. It prints latency percentiles, main-thread time per request and
long tasks, with the difference to the page without the SDK, and fails above 1 ms added at p95 or on any failed
request. It starts the bench page on `127.0.0.1:5186` and a release collector of its own on `127.0.0.1:34318`/`34320`
(the first run builds it), so the demo stack can stay up. The default run takes about 9 minutes;
`SDK_OVERHEAD_MODES`, `SDK_OVERHEAD_RATE`, `SDK_OVERHEAD_WORKERS`, `SDK_OVERHEAD_SECONDS` and `SDK_OVERHEAD_ROUNDS`
change the setup.

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
