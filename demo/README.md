# Demo app

The full-stack app that chepio-lens instruments and its end-to-end tests drive: a React page, a Rust API (axum,
sqlx) and Postgres. It has no telemetry of its own yet.

## Run

```sh
docker compose -f demo/compose.yaml up --build
```

Open http://localhost:5173. Every port is published on `127.0.0.1` only:

| Service | Host address | Notes |
|---|---|---|
| web | `127.0.0.1:5173` | Vite dev server; proxies `/api` to the API, so the browser stays on one origin |
| api | `127.0.0.1:8080` | Runs migrations on startup |
| db | `127.0.0.1:55432` | Postgres 17, user `demo`, password `demo`, database `demo` |

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

## Run without Docker

```sh
docker compose -f demo/compose.yaml up -d db
DATABASE_URL=postgres://demo:demo@127.0.0.1:55432/demo cargo run -p demo-api
pnpm --filter demo-web dev
```

`DEMO_API_ADDR` sets the API listener (default `127.0.0.1:8080`); `DEMO_API_URL` sets the web proxy target.
