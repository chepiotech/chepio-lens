//! Server spans from the axum layer, exported to memory.

// Core
use axum::Router;
use axum::body::Body;
use axum::http::{Request, StatusCode};
use axum::routing::get;
use chepio_lens_sdk::{Config, Lens, init_with};
use opentelemetry::trace::{SpanKind, Status};
use opentelemetry::{Key, Value};
use opentelemetry_sdk::trace::{InMemorySpanExporter, SpanData};
use tower::ServiceExt;

fn attribute(span: &SpanData, key: &str) -> Option<Value> {
    span.attributes
        .iter()
        .find(|kv| kv.key == Key::from(key.to_owned()))
        .map(|kv| kv.value.clone())
}

fn app(lens: &Lens) -> Router {
    Router::new()
        .route("/notes/{id}", get(|| async { "note" }))
        .route("/fail", get(|| async { StatusCode::INTERNAL_SERVER_ERROR }))
        .layer(lens.http_layer())
}

#[tokio::test]
async fn server_span_joins_the_callers_trace_and_names_the_route() {
    let exporter = InMemorySpanExporter::default();
    let lens = Lens::with_exporter("demo-api", exporter.clone());
    let request = Request::get("/notes/7?draft=1")
        .header(
            "traceparent",
            "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01",
        )
        .body(Body::empty())
        .unwrap();

    let response = app(&lens).oneshot(request).await.unwrap();

    assert_eq!(response.status(), StatusCode::OK);
    let spans = exporter.get_finished_spans().unwrap();
    assert_eq!(spans.len(), 1);
    let span = &spans[0];
    assert_eq!(span.name, "GET /notes/{id}");
    assert_eq!(span.span_kind, SpanKind::Server);
    assert_eq!(
        span.span_context.trace_id().to_string(),
        "4bf92f3577b34da6a3ce929d0e0e4736"
    );
    assert_eq!(span.parent_span_id.to_string(), "00f067aa0ba902b7");
    assert_eq!(attribute(span, "http.route"), Some("/notes/{id}".into()));
    assert_eq!(attribute(span, "url.path"), Some("/notes/7".into()));
    assert_eq!(attribute(span, "url.query"), Some("draft=1".into()));
    assert_eq!(
        attribute(span, "http.response.status_code"),
        Some(200_i64.into())
    );
    assert_eq!(span.status, Status::Unset);
}

#[tokio::test]
async fn server_errors_mark_the_span_and_requests_without_traceparent_start_a_trace() {
    let exporter = InMemorySpanExporter::default();
    let lens = Lens::with_exporter("demo-api", exporter.clone());

    app(&lens)
        .oneshot(Request::get("/fail").body(Body::empty()).unwrap())
        .await
        .unwrap();

    let span = &exporter.get_finished_spans().unwrap()[0];
    assert!(matches!(span.status, Status::Error { .. }));
    assert_eq!(
        attribute(span, "http.response.status_code"),
        Some(500_i64.into())
    );
    assert!(span.span_context.is_valid());
    assert_eq!(span.parent_span_id.to_string(), "0000000000000000");
}

#[tokio::test]
async fn without_an_endpoint_the_sdk_does_nothing() {
    let lens = init_with(Config {
        service_name: "demo-api".into(),
        endpoint: None,
    })
    .unwrap();

    assert!(!lens.is_enabled());
    assert!(
        lens.install_tracing().is_ok(),
        "installs nothing, so it cannot clash"
    );
    let response = app(&lens)
        .oneshot(Request::get("/notes/1").body(Body::empty()).unwrap())
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    lens.shutdown();
}
