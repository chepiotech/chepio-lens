//! HTTP-level tests: OTLP fixtures posted to the ingest router, then read back through the UI API and SSE.

// Core
use std::sync::Arc;
use std::time::Duration;

use axum::Router;
use axum::body::{Body, Bytes};
use axum::http::{Request, StatusCode, header};
use chepio_lens_collector::app::{Limits, build};
use chepio_lens_collector::domain::time::Now;
use chepio_lens_collector::handlers::{AppState, otlp_router, ui_router};
use http_body_util::BodyExt;
use opentelemetry_proto::tonic::collector::trace::v1::{
    ExportTraceServiceRequest, ExportTraceServiceResponse,
};
use prost::Message;
use serde_json::Value;
use tower::ServiceExt;

const DEMO_TRACE: &str = include_str!("fixtures/demo_trace.json");

struct App {
    state: Arc<AppState>,
    otlp: Router,
    ui: Router,
}

fn app(limits: Limits) -> App {
    let state = build(&[], limits);
    App {
        otlp: otlp_router(state.clone()),
        ui: ui_router(state.clone()),
        state,
    }
}

fn protobuf_fixture() -> Vec<u8> {
    serde_json::from_str::<ExportTraceServiceRequest>(DEMO_TRACE)
        .unwrap()
        .encode_to_vec()
}

async fn post(
    router: &Router,
    uri: &str,
    content_type: &str,
    body: impl Into<Body>,
) -> (StatusCode, Bytes) {
    let request = Request::post(uri)
        .header(header::CONTENT_TYPE, content_type)
        .body(body.into())
        .unwrap();
    let response = router.clone().oneshot(request).await.unwrap();
    let status = response.status();
    (
        status,
        response.into_body().collect().await.unwrap().to_bytes(),
    )
}

async fn get_json(router: &Router, uri: &str) -> Value {
    let response = router
        .clone()
        .oneshot(Request::get(uri).body(Body::empty()).unwrap())
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK, "GET {uri}");
    serde_json::from_slice(&response.into_body().collect().await.unwrap().to_bytes()).unwrap()
}

fn edge<'a>(graph: &'a Value, id: &str) -> &'a Value {
    graph["edges"]
        .as_array()
        .unwrap()
        .iter()
        .find(|edge| edge["id"] == id)
        .unwrap_or_else(|| panic!("no edge {id} in {graph}"))
}

#[tokio::test]
async fn protobuf_export_appears_on_the_graph() {
    let app = app(Limits::default());

    let (status, body) = post(
        &app.otlp,
        "/v1/traces",
        "application/x-protobuf",
        protobuf_fixture(),
    )
    .await;

    assert_eq!(status, StatusCode::OK);
    let response = ExportTraceServiceResponse::decode(body).unwrap();
    assert!(response.partial_success.is_none());
    let graph = get_json(&app.ui, "/api/graph").await;
    let mut nodes: Vec<(String, String)> = graph["nodes"]
        .as_array()
        .unwrap()
        .iter()
        .map(|node| {
            (
                node["id"].as_str().unwrap().into(),
                node["kind"].as_str().unwrap().into(),
            )
        })
        .collect();
    nodes.sort();
    assert_eq!(
        nodes,
        [
            ("db:postgresql:db:5432/demo".into(), "database".into()),
            ("svc:demo-api".into(), "service".into()),
            ("svc:demo-web".into(), "frontend".into()),
        ]
    );
    let db = edge(&graph, "svc:demo-api->db:postgresql:db:5432/demo");
    assert_eq!(
        (
            db["count"].as_u64(),
            db["errors"].as_u64(),
            db["protocol"].as_str()
        ),
        (Some(1), Some(0), Some("db"))
    );
    assert!(db["p50_ms"].as_f64().unwrap() >= 4.0);
    assert_eq!(edge(&graph, "svc:demo-web->svc:demo-api")["count"], 1);
}

#[tokio::test]
async fn json_export_is_accepted_and_answered_in_json() {
    let app = app(Limits::default());

    let (status, body) = post(&app.otlp, "/v1/traces", "application/json", DEMO_TRACE).await;

    assert_eq!((status, body.as_ref()), (StatusCode::OK, b"{}".as_ref()));
    assert_eq!(
        get_json(&app.ui, "/api/graph").await["edges"]
            .as_array()
            .unwrap()
            .len(),
        2
    );
}

#[tokio::test]
async fn unanswered_client_reaches_its_external_node_after_the_link_window() {
    let app = app(Limits::default());
    post(&app.otlp, "/v1/traces", "application/json", DEMO_TRACE).await;
    let now = app.state.clock.now();

    app.state.ingest.tick(Now {
        mono_ms: now.mono_ms + 10_000,
        ..now
    });

    let graph = get_json(&app.ui, "/api/graph").await;
    assert_eq!(
        edge(&graph, "svc:demo-api->ext:payments.example.com:443")["count"],
        1
    );
}

#[tokio::test]
async fn invalid_exports_get_the_otlp_status_codes() {
    let mut limits = Limits::default();
    limits.http.max_body_bytes = 64;
    let small = app(limits);
    limits.http.max_concurrent_ingest = 0;
    let busy = app(limits);

    assert_eq!(
        post(&small.otlp, "/v1/traces", "text/plain", "x").await.0,
        StatusCode::UNSUPPORTED_MEDIA_TYPE
    );
    assert_eq!(
        post(&small.otlp, "/v1/traces", "application/json", "{oops")
            .await
            .0,
        StatusCode::BAD_REQUEST
    );
    assert_eq!(
        post(&small.otlp, "/v1/traces", "application/json", DEMO_TRACE)
            .await
            .0,
        StatusCode::PAYLOAD_TOO_LARGE
    );
    let response = busy
        .otlp
        .clone()
        .oneshot(
            Request::post("/v1/traces")
                .header(header::CONTENT_TYPE, "application/json")
                .body(Body::from("{}"))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::SERVICE_UNAVAILABLE);
    assert_eq!(response.headers()[header::RETRY_AFTER], "1");

    let stats = get_json(&busy.ui, "/api/stats").await;
    assert_eq!(stats["batches_busy"], 1);
    assert_eq!(
        get_json(&small.ui, "/api/stats").await["batches_malformed"],
        1
    );
}

#[tokio::test]
async fn spans_over_the_per_request_bound_are_reported_as_rejected() {
    let mut limits = Limits::default();
    limits.store.max_spans_per_request = 2;
    let app = app(limits);

    let (_, body) = post(
        &app.otlp,
        "/v1/traces",
        "application/x-protobuf",
        protobuf_fixture(),
    )
    .await;

    let partial = ExportTraceServiceResponse::decode(body)
        .unwrap()
        .partial_success
        .unwrap();
    assert_eq!(partial.rejected_spans, 2);
    let stats = get_json(&app.ui, "/api/stats").await;
    assert_eq!(
        (
            stats["spans_received"].as_u64(),
            stats["spans_dropped"].as_u64()
        ),
        (Some(4), Some(2))
    );
}

/// Reads SSE frames until one with `event: <name>` arrives.
async fn next_event(body: &mut Body, name: &str) -> String {
    let wanted = format!("event: {name}\n");
    let mut buffer = String::new();
    tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            let frame = body.frame().await.expect("stream ended").unwrap();
            if let Ok(data) = frame.into_data() {
                buffer.push_str(std::str::from_utf8(&data).unwrap());
                if let Some(start) = buffer.find(&wanted) {
                    return buffer[start..].to_owned();
                }
            }
        }
    })
    .await
    .unwrap_or_else(|_| panic!("no {name} event; got {buffer:?}"))
}

#[tokio::test]
async fn events_stream_reports_new_nodes_edges_and_requests() {
    let app = app(Limits::default());
    let response = app
        .ui
        .clone()
        .oneshot(Request::get("/api/events").body(Body::empty()).unwrap())
        .await
        .unwrap();
    assert_eq!(
        response.headers()[header::CONTENT_TYPE],
        "text/event-stream"
    );
    let mut body = response.into_body();

    post(&app.otlp, "/v1/traces", "application/json", DEMO_TRACE).await;

    assert!(
        next_event(&mut body, "node")
            .await
            .contains("\"id\":\"db:postgresql:db:5432/demo\"")
    );
    assert!(
        next_event(&mut body, "edge")
            .await
            .contains("\"protocol\":\"db\"")
    );
    let request = next_event(&mut body, "request").await;
    assert!(
        request.contains("\"trace_id\":\"4bf92f3577b34da6a3ce929d0e0e4736\""),
        "{request}"
    );
    assert!(request.contains("\"edges\":[\"svc:demo-web->svc:demo-api\",\"svc:demo-api->db:postgresql:db:5432/demo\"]"), "{request}");
}

#[tokio::test]
async fn event_streams_are_bounded_and_free_their_slot_on_disconnect() {
    let mut limits = Limits::default();
    limits.http.max_sse_clients = 1;
    let app = app(limits);
    let open = || {
        app.ui
            .clone()
            .oneshot(Request::get("/api/events").body(Body::empty()).unwrap())
    };

    let first = open().await.unwrap();
    assert_eq!(first.status(), StatusCode::OK);
    assert_eq!(
        open().await.unwrap().status(),
        StatusCode::SERVICE_UNAVAILABLE
    );
    assert_eq!(get_json(&app.ui, "/api/stats").await["sse_clients"], 1);

    drop(first);
    assert_eq!(open().await.unwrap().status(), StatusCode::OK);
}

#[tokio::test]
async fn reset_clears_the_graph_and_health_answers() {
    let app = app(Limits::default());
    post(&app.otlp, "/v1/traces", "application/json", DEMO_TRACE).await;

    assert_eq!(
        post(&app.ui, "/api/reset", "application/json", "").await.0,
        StatusCode::NO_CONTENT
    );

    let graph = get_json(&app.ui, "/api/graph").await;
    assert!(graph["nodes"].as_array().unwrap().is_empty());
    assert!(
        graph["generated_at"]
            .as_str()
            .unwrap()
            .parse::<u64>()
            .is_ok()
    );
    let health = app
        .ui
        .clone()
        .oneshot(Request::get("/healthz").body(Body::empty()).unwrap())
        .await
        .unwrap();
    assert_eq!(health.status(), StatusCode::OK);
}
