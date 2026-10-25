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
/// The demo web's origin; `app()` allows it, as the collector does by default.
const ORIGIN: &str = "http://localhost:5173";

struct App {
    state: Arc<AppState>,
    otlp: Router,
    ui: Router,
}

fn app(limits: Limits) -> App {
    let state = build(&[], &[ORIGIN.to_owned()], limits);
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
    // Browser fetch 30 ms around a 26 ms server span: 2 ms network each way, then the query 3 ms into the server span.
    assert!(
        request.contains(concat!(
            r#""hops":[{"edge":"svc:demo-web->svc:demo-api","start_offset_ms":0.0,"duration_ms":30.0},"#,
            r#"{"edge":"svc:demo-api->db:postgresql:db:5432/demo","start_offset_ms":5.0,"duration_ms":4.0}]"#
        )),
        "{request}"
    );
    assert!(request.contains(r#""name":"GET /api/notes""#), "{request}");
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

const RUST_SDK_NOTES: &[u8] = include_bytes!("fixtures/rust_sdk_notes.pb");
const RUST_SDK_FAIL: &[u8] = include_bytes!("fixtures/rust_sdk_fail.pb");

/// Batches recorded from the real Rust SDK exporter (`fixtures/README.md`).
#[tokio::test]
async fn batches_from_the_rust_sdk_show_the_api_and_its_database() {
    let app = app(Limits::default());
    let response = app
        .ui
        .clone()
        .oneshot(Request::get("/api/events").body(Body::empty()).unwrap())
        .await
        .unwrap();
    let mut events = response.into_body();

    for batch in [RUST_SDK_NOTES, RUST_SDK_FAIL] {
        let (status, _) = post(
            &app.otlp,
            "/v1/traces",
            "application/x-protobuf",
            batch.to_vec(),
        )
        .await;
        assert_eq!(status, StatusCode::OK);
    }

    let graph = get_json(&app.ui, "/api/graph").await;
    let db = edge(&graph, "svc:demo-api->db:postgresql:127.0.0.1:55432/demo");
    assert_eq!(db["count"], 2);
    assert_eq!(
        db["errors"], 0,
        "sqlx query events carry no error (ADR-0008)"
    );
    let notes = next_event(&mut events, "request").await;
    assert!(notes.contains("\"route\":\"/api/notes\""), "{notes}");
    assert!(notes.contains("\"status_code\":200"), "{notes}");
    let fail = next_event(&mut events, "request").await;
    assert!(fail.contains("\"route\":\"/api/fail\""), "{fail}");
    assert!(
        fail.contains("\"error\":true"),
        "the 500 marks the request: {fail}"
    );
}

#[tokio::test]
async fn ui_listener_sends_security_headers_and_serves_or_explains_the_ui() {
    let app = app(Limits::default());
    for uri in ["/", "/api/graph", "/healthz"] {
        let response = app
            .ui
            .clone()
            .oneshot(Request::get(uri).body(Body::empty()).unwrap())
            .await
            .unwrap();
        let headers = response.headers();
        assert_eq!(
            headers[header::CONTENT_SECURITY_POLICY],
            "default-src 'self'; connect-src 'self'",
            "{uri}"
        );
        assert_eq!(headers[header::X_CONTENT_TYPE_OPTIONS], "nosniff", "{uri}");
        if uri == "/" {
            // CI runs the Rust tests without building the UI first; both outcomes are valid here.
            let status = response.status();
            let body = response.into_body().collect().await.unwrap().to_bytes();
            match status {
                StatusCode::OK => {
                    assert!(String::from_utf8_lossy(&body).contains("<div id=\"root\">"))
                }
                StatusCode::NOT_FOUND => {
                    assert!(String::from_utf8_lossy(&body).contains("pnpm --filter ui build"))
                }
                other => panic!("unexpected status {other} for /"),
            }
        }
    }
}

fn preflight(origin: &str) -> Request<Body> {
    Request::options("/v1/traces")
        .header(header::ORIGIN, origin)
        .header(header::ACCESS_CONTROL_REQUEST_METHOD, "POST")
        .header(header::ACCESS_CONTROL_REQUEST_HEADERS, "content-type")
        .body(Body::empty())
        .unwrap()
}

fn browser_export(origin: &str) -> Request<Body> {
    Request::post("/v1/traces")
        .header(header::ORIGIN, origin)
        .header(header::CONTENT_TYPE, "application/json")
        .body(Body::from(DEMO_TRACE))
        .unwrap()
}

async fn send(router: &Router, request: Request<Body>) -> axum::response::Response {
    router.clone().oneshot(request).await.unwrap()
}

#[tokio::test]
async fn preflight_from_an_allowed_origin_is_answered() {
    let app = app(Limits::default());

    let response = send(&app.otlp, preflight(ORIGIN)).await;

    assert_eq!(response.status(), StatusCode::OK);
    let headers = response.headers();
    assert_eq!(headers[header::ACCESS_CONTROL_ALLOW_ORIGIN], ORIGIN);
    assert_eq!(headers[header::ACCESS_CONTROL_ALLOW_METHODS], "POST");
    assert_eq!(
        headers[header::ACCESS_CONTROL_ALLOW_HEADERS],
        "content-type"
    );
    assert_eq!(headers[header::ACCESS_CONTROL_MAX_AGE], "600");
    assert!(
        headers
            .get_all(header::VARY)
            .iter()
            .any(|value| value.to_str().unwrap().contains("origin"))
    );
}

#[tokio::test]
async fn browser_export_from_an_allowed_origin_can_read_the_answer() {
    let mut limits = Limits::default();
    limits.http.max_concurrent_ingest = 0;
    let busy = app(limits);
    let app = app(Limits::default());

    let accepted = send(&app.otlp, browser_export(ORIGIN)).await;
    let refused = send(&busy.otlp, browser_export(ORIGIN)).await;

    assert_eq!(accepted.status(), StatusCode::OK);
    assert_eq!(
        accepted.headers()[header::ACCESS_CONTROL_ALLOW_ORIGIN],
        ORIGIN
    );
    // The browser exporter honors `Retry-After` only when CORS exposes it.
    assert_eq!(refused.status(), StatusCode::SERVICE_UNAVAILABLE);
    assert_eq!(
        refused.headers()[header::ACCESS_CONTROL_ALLOW_ORIGIN],
        ORIGIN
    );
    assert_eq!(
        refused.headers()[header::ACCESS_CONTROL_EXPOSE_HEADERS],
        "retry-after"
    );
    assert_eq!(get_json(&app.ui, "/api/stats").await["spans_received"], 4);
}

#[tokio::test]
async fn other_browser_origins_get_403_and_ingest_nothing() {
    let app = app(Limits::default());

    for origin in ["http://evil.test", "null", "http://localhost:5174"] {
        for request in [preflight(origin), browser_export(origin)] {
            let response = send(&app.otlp, request).await;
            assert_eq!(response.status(), StatusCode::FORBIDDEN, "{origin}");
            assert!(
                !response
                    .headers()
                    .contains_key(header::ACCESS_CONTROL_ALLOW_ORIGIN),
                "{origin}"
            );
        }
    }
    assert_eq!(get_json(&app.ui, "/api/stats").await["spans_received"], 0);
}

#[tokio::test]
async fn backend_exports_without_origin_are_not_affected_by_cors() {
    let app = app(Limits::default());

    let response = send(
        &app.otlp,
        Request::post("/v1/traces")
            .header(header::CONTENT_TYPE, "application/x-protobuf")
            .body(Body::from(protobuf_fixture()))
            .unwrap(),
    )
    .await;

    assert_eq!(response.status(), StatusCode::OK);
    assert!(
        !response
            .headers()
            .contains_key(header::ACCESS_CONTROL_ALLOW_ORIGIN)
    );
}

const WEB_SDK_NOTES: &str = include_str!("fixtures/web_sdk_notes.json");
const WEB_API_NOTES: &[u8] = include_bytes!("fixtures/web_api_notes.pb");
const WEB_TO_API: &str = "svc:demo-web->svc:demo-api";
const API_TO_DB: &str = "svc:demo-api->db:postgresql:127.0.0.1:55432/demo";

fn node_kinds(graph: &Value) -> Vec<(String, String)> {
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
    nodes
}

/// Browser (web SDK, JSON) and API (Rust SDK, protobuf) batches recorded in one session (`fixtures/README.md`):
/// three fetches, each answered by the API with one query.
#[tokio::test]
async fn browser_and_api_batches_link_into_web_api_database_in_either_order() {
    for browser_first in [true, false] {
        let app = app(Limits::default());
        let browser = || post(&app.otlp, "/v1/traces", "application/json", WEB_SDK_NOTES);
        let api = || {
            post(
                &app.otlp,
                "/v1/traces",
                "application/x-protobuf",
                WEB_API_NOTES.to_vec(),
            )
        };

        let statuses = if browser_first {
            [browser().await.0, api().await.0]
        } else {
            [api().await.0, browser().await.0]
        };

        assert_eq!(
            statuses,
            [StatusCode::OK; 2],
            "browser first: {browser_first}"
        );
        let graph = get_json(&app.ui, "/api/graph").await;
        assert_eq!(
            node_kinds(&graph),
            [
                (
                    "db:postgresql:127.0.0.1:55432/demo".into(),
                    "database".into()
                ),
                ("svc:demo-api".into(), "service".into()),
                ("svc:demo-web".into(), "frontend".into()),
            ],
            "browser first: {browser_first}"
        );
        let web = edge(&graph, WEB_TO_API);
        assert_eq!(
            (
                web["count"].as_u64(),
                web["errors"].as_u64(),
                web["protocol"].as_str()
            ),
            (Some(3), Some(0), Some("http")),
            "browser first: {browser_first}"
        );
        assert_eq!(
            edge(&graph, API_TO_DB)["count"],
            3,
            "browser first: {browser_first}"
        );
    }
}

/// Without the API's spans (no `traceparent` reached a traced backend) the browser's calls count on the host they
/// went to once the link window has passed.
#[tokio::test]
async fn browser_calls_without_a_traced_backend_reach_an_external_node() {
    let app = app(Limits::default());
    post(&app.otlp, "/v1/traces", "application/json", WEB_SDK_NOTES).await;
    let now = app.state.clock.now();

    app.state.ingest.tick(Now {
        mono_ms: now.mono_ms + 10_000,
        ..now
    });

    let graph = get_json(&app.ui, "/api/graph").await;
    assert_eq!(edge(&graph, "svc:demo-web->ext:localhost:5173")["count"], 3);
}
