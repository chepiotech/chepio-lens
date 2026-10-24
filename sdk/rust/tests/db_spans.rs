//! Database client spans from sqlx query events against a real Postgres (ADR-0008). Needs `DATABASE_URL`, like the
//! demo API tests.

// Core
use std::time::Duration;

use axum::Router;
use axum::body::Body;
use axum::extract::State;
use axum::http::{Request, StatusCode};
use axum::routing::get;
use chepio_lens_sdk::{Database, Lens};
use opentelemetry::trace::SpanKind;
use opentelemetry::{Key, Value};
use opentelemetry_sdk::trace::{InMemorySpanExporter, SpanData};
use sqlx::PgPool;
use tower::ServiceExt;
use tracing_subscriber::prelude::*;

fn attribute(span: &SpanData, key: &str) -> Option<Value> {
    span.attributes
        .iter()
        .find(|kv| kv.key == Key::from(key.to_owned()))
        .map(|kv| kv.value.clone())
}

async fn handler(State(pool): State<PgPool>) -> StatusCode {
    sqlx::query("SELECT pg_sleep(0.05)")
        .execute(&pool)
        .await
        .unwrap();
    let failed = sqlx::query("SELECT id FROM chepio_lens_sdk_missing_table")
        .execute(&pool)
        .await;
    assert!(failed.is_err());
    StatusCode::OK
}

/// The single-threaded runtime keeps the handler on this thread, where the test's tracing subscriber is set.
#[tokio::test(flavor = "current_thread")]
async fn queries_inside_a_request_become_child_client_spans() {
    let url = std::env::var("DATABASE_URL").expect(
        "DATABASE_URL must point to Postgres: docker compose -f demo/compose.yaml up -d db",
    );
    let pool = PgPool::connect(&url).await.unwrap();
    let exporter = InMemorySpanExporter::default();
    let lens = Lens::with_exporter("demo-api", exporter.clone()).with_database(Database::new(
        "postgresql",
        Some("db"),
        Some(5432),
        Some("demo"),
    ));
    let _subscriber =
        tracing::subscriber::set_default(tracing_subscriber::registry().with(lens.tracing_layer()));
    let app = Router::new()
        .route("/notes", get(handler))
        .with_state(pool)
        .layer(lens.http_layer());

    let response = app
        .oneshot(Request::get("/notes").body(Body::empty()).unwrap())
        .await
        .unwrap();

    assert_eq!(response.status(), StatusCode::OK);
    let spans = exporter.get_finished_spans().unwrap();
    let server = spans
        .iter()
        .find(|span| span.span_kind == SpanKind::Server)
        .unwrap();
    let queries: Vec<&SpanData> = spans
        .iter()
        .filter(|span| span.span_kind == SpanKind::Client)
        .collect();
    assert_eq!(queries.len(), 2, "{spans:#?}");

    let sleep = queries[0];
    assert_eq!(sleep.parent_span_id, server.span_context.span_id());
    assert_eq!(
        sleep.span_context.trace_id(),
        server.span_context.trace_id()
    );
    assert_eq!(sleep.name, "SELECT demo");
    assert_eq!(
        attribute(sleep, "db.query.text"),
        Some("SELECT pg_sleep(0.05)".into())
    );
    assert_eq!(
        attribute(sleep, "db.system.name"),
        Some("postgresql".into())
    );
    assert_eq!(attribute(sleep, "server.address"), Some("db".into()));
    assert_eq!(attribute(sleep, "server.port"), Some(5432_i64.into()));
    assert_eq!(attribute(sleep, "db.namespace"), Some("demo".into()));
    let took = sleep.end_time.duration_since(sleep.start_time).unwrap();
    assert!(took >= Duration::from_millis(50), "took {took:?}");

    let failed = queries[1];
    assert_eq!(failed.parent_span_id, server.span_context.span_id());
    assert_eq!(
        attribute(failed, "db.query.text"),
        Some("SELECT id FROM chepio_lens_sdk_missing_table".into()),
        "a failing query still gets its span (without an error status, ADR-0008)"
    );
}
