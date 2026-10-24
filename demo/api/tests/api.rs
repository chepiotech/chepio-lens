//! HTTP-level tests against a real Postgres. `#[sqlx::test]` creates a fresh database per test from `DATABASE_URL`
//! and applies `migrations/`.

// Core
use std::time::Instant;

use axum::Router;
use axum::body::Body;
use axum::http::{Request, StatusCode, header};
use http_body_util::BodyExt;
use serde_json::{Value, json};
use sqlx::PgPool;
use tower::ServiceExt;
// Handlers
use demo_api::app;

async fn send(app: &Router, method: &str, uri: &str, body: Option<Value>) -> (StatusCode, Value) {
    let request = Request::builder().method(method).uri(uri);
    let request = match body {
        Some(body) => request
            .header(header::CONTENT_TYPE, "application/json")
            .body(Body::from(body.to_string())),
        None => request.body(Body::empty()),
    }
    .unwrap();
    let response = app.clone().oneshot(request).await.unwrap();
    let status = response.status();
    let bytes = response.into_body().collect().await.unwrap().to_bytes();
    // axum's own rejections (e.g. 413) answer in plain text; keep those as a JSON string.
    let body = match bytes.is_empty() {
        true => Value::Null,
        false => serde_json::from_slice(&bytes)
            .unwrap_or_else(|_| Value::String(String::from_utf8_lossy(&bytes).into_owned())),
    };
    (status, body)
}

#[sqlx::test]
async fn health_responds_ok(pool: PgPool) {
    let (status, body) = send(&app(pool), "GET", "/api/health", None).await;

    assert_eq!(status, StatusCode::OK);
    assert_eq!(body, json!({ "status": "ok" }));
}

#[sqlx::test]
async fn notes_round_trip_through_create_read_update_delete(pool: PgPool) {
    let app = app(pool);

    let (status, created) = send(
        &app,
        "POST",
        "/api/notes",
        Some(json!({ "text": "  first note  " })),
    )
    .await;
    assert_eq!(status, StatusCode::CREATED);
    assert_eq!(created["text"], "first note");
    let uri = format!("/api/notes/{}", created["id"]);

    assert_eq!(
        send(&app, "GET", &uri, None).await,
        (StatusCode::OK, created.clone())
    );
    assert_eq!(
        send(&app, "GET", "/api/notes", None).await,
        (StatusCode::OK, json!([created]))
    );

    let (status, updated) = send(&app, "PUT", &uri, Some(json!({ "text": "edited" }))).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(updated, json!({ "id": created["id"], "text": "edited" }));

    assert_eq!(
        send(&app, "DELETE", &uri, None).await,
        (StatusCode::NO_CONTENT, Value::Null)
    );
    assert_eq!(send(&app, "GET", &uri, None).await.0, StatusCode::NOT_FOUND);
    assert_eq!(
        send(&app, "DELETE", &uri, None).await.0,
        StatusCode::NOT_FOUND
    );
    assert_eq!(
        send(&app, "PUT", &uri, Some(json!({ "text": "gone" })))
            .await
            .0,
        StatusCode::NOT_FOUND
    );
}

#[sqlx::test]
async fn list_returns_newest_first_and_at_most_100(pool: PgPool) {
    sqlx::query("INSERT INTO notes (text) SELECT 'note ' || n FROM generate_series(1, 101) AS n")
        .execute(&pool)
        .await
        .unwrap();

    let (status, notes) = send(&app(pool), "GET", "/api/notes", None).await;

    assert_eq!(status, StatusCode::OK);
    let notes = notes.as_array().unwrap();
    assert_eq!(notes.len(), 100);
    assert_eq!(notes[0]["text"], "note 101");
    assert_eq!(notes[99]["text"], "note 2");
}

#[sqlx::test]
async fn note_text_must_have_1_to_1000_characters(pool: PgPool) {
    let app = app(pool);
    let create = |text: String| send(&app, "POST", "/api/notes", Some(json!({ "text": text })));

    assert_eq!(
        create("   ".into()).await.0,
        StatusCode::UNPROCESSABLE_ENTITY
    );
    assert_eq!(
        create("x".repeat(1001)).await.0,
        StatusCode::UNPROCESSABLE_ENTITY
    );
    assert_eq!(create("x".repeat(1000)).await.0, StatusCode::CREATED);
    // Characters, not bytes: 1000 two-byte characters fit the API check and the database constraint alike.
    assert_eq!(create("é".repeat(1000)).await.0, StatusCode::CREATED);
}

#[sqlx::test]
async fn oversized_body_is_rejected(pool: PgPool) {
    let (status, _) = send(
        &app(pool),
        "POST",
        "/api/notes",
        Some(json!({ "text": "x".repeat(70_000) })),
    )
    .await;

    assert_eq!(status, StatusCode::PAYLOAD_TOO_LARGE);
}

#[sqlx::test]
async fn login_accepts_only_the_demo_credentials(pool: PgPool) {
    let app = app(pool);

    let (status, body) = send(
        &app,
        "POST",
        "/api/login",
        Some(json!({ "username": "demo", "password": "demo-password" })),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body, json!({ "token": "demo-session-token" }));

    let (status, body) = send(
        &app,
        "POST",
        "/api/login",
        Some(json!({ "username": "demo", "password": "wrong" })),
    )
    .await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);
    assert_eq!(body, json!({ "error": "invalid credentials" }));
}

#[sqlx::test]
async fn slow_sleeps_between_300_and_800_ms(pool: PgPool) {
    let started = Instant::now();
    let (status, body) = send(&app(pool), "GET", "/api/slow", None).await;
    let elapsed_ms = started.elapsed().as_millis() as u64;

    assert_eq!(status, StatusCode::OK);
    let slept_ms = body["slept_ms"].as_u64().unwrap();
    assert!((300..=800).contains(&slept_ms), "slept {slept_ms} ms");
    assert!(
        elapsed_ms >= slept_ms,
        "answered after {elapsed_ms} ms, reported {slept_ms} ms"
    );
}

#[sqlx::test]
async fn fail_returns_500_after_a_failing_query(pool: PgPool) {
    let (status, body) = send(&app(pool), "GET", "/api/fail", None).await;

    assert_eq!(status, StatusCode::INTERNAL_SERVER_ERROR);
    assert_eq!(body, json!({ "error": "database error" }));
}
