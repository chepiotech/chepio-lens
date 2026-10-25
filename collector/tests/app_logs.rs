//! App log contract: both OTLP encodings, redaction, filtering, bounds and late trace correlation.
// Core
use axum::{
    Router,
    body::Body,
    http::{Request, StatusCode},
};
use chepio_lens_collector::{
    app::{Limits, build},
    handlers::{otlp_router, ui_router},
};
use http_body_util::BodyExt;
use opentelemetry_proto::tonic::collector::logs::v1::{
    ExportLogsServiceRequest, ExportLogsServiceResponse,
};
use prost::Message;
use serde_json::{Value, json};
use tower::ServiceExt;

fn app(limits: Limits) -> (Router, Router) {
    let state = build(
        &["tenant".to_owned()],
        &["http://localhost:5173".to_owned()],
        limits,
    );
    (otlp_router(state.clone()), ui_router(state))
}
fn batch(records: Value) -> Value {
    json!({"resourceLogs":[{"resource":{"attributes":[{"key":"service.name","value":{"stringValue":"api"}}]},"scopeLogs":[{"logRecords":records}]}]})
}
fn record(time: u64, body: &str) -> Value {
    json!({"timeUnixNano":time.to_string(),"severityNumber":9,"body":{"stringValue":body}})
}
async fn send(
    router: &Router,
    path: &str,
    content_type: &str,
    body: Vec<u8>,
) -> (StatusCode, Vec<u8>) {
    let response = router
        .clone()
        .oneshot(
            Request::post(path)
                .header("content-type", content_type)
                .body(Body::from(body))
                .unwrap(),
        )
        .await
        .unwrap();
    (
        response.status(),
        response
            .into_body()
            .collect()
            .await
            .unwrap()
            .to_bytes()
            .to_vec(),
    )
}
async fn get(router: &Router, path: &str) -> Value {
    let response = router
        .clone()
        .oneshot(Request::get(path).body(Body::empty()).unwrap())
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    serde_json::from_slice(&response.into_body().collect().await.unwrap().to_bytes()).unwrap()
}

#[tokio::test]
async fn json_and_protobuf_logs_redact_structured_fields_without_inventing_requests() {
    for protobuf in [false, true] {
        let (otlp, ui) = app(Limits::default());
        let mut entry = record(10, "application started");
        entry["attributes"] = json!([
            {"key":"password","value":{"stringValue":"fake-log-password"}},
            {"key":"tenant","value":{"intValue":"42"}},
            {"key":"http.request.header.authorization","value":{"stringValue":"Bearer fake-header-secret"}},
            {"key":"http.request.header.content-type","value":{"stringValue":"application/x-www-form-urlencoded"}},
            {"key":"lens.http.request.body","value":{"stringValue":"username=demo&password=fake-form-secret"}},
            {"key":"nested","value":{"kvlistValue":{"values":[{"key":"token","value":{"stringValue":"fake-nested-token"}},{"key":"ok","value":{"boolValue":true}}]}}}
        ]);
        let mut structured = record(11, "");
        structured["body"] = json!({"kvlistValue":{"values":[{"key":"secret","value":{"stringValue":"fake-body-secret"}}]}});
        structured["severityNumber"] = json!(17);
        let invalid = json!({"spanId":"1111111111111111","body":{"stringValue":"invalid context"}});
        let payload = batch(json!([entry, structured, invalid]));
        let (content_type, bytes) = if protobuf {
            (
                "application/x-protobuf",
                serde_json::from_value::<ExportLogsServiceRequest>(payload)
                    .unwrap()
                    .encode_to_vec(),
            )
        } else {
            ("application/json", serde_json::to_vec(&payload).unwrap())
        };
        let (status, response) = send(&otlp, "/v1/logs", content_type, bytes).await;
        assert_eq!(status, StatusCode::OK);
        let response: ExportLogsServiceResponse = if protobuf {
            ExportLogsServiceResponse::decode(response.as_slice()).unwrap()
        } else {
            serde_json::from_slice(&response).unwrap()
        };
        assert_eq!(response.partial_success.unwrap().rejected_log_records, 1);
        let logs = get(&ui, "/api/logs").await;
        assert_eq!(logs["entries"].as_array().unwrap().len(), 2);
        let wire = logs.to_string();
        for secret in [
            "fake-log-password",
            "fake-nested-token",
            "fake-body-secret",
            "fake-header-secret",
            "fake-form-secret",
        ] {
            assert!(!wire.contains(secret));
        }
        assert!(wire.contains("[REDACTED]"));
        assert!(logs["entries"][0]["trace_id"].is_null());
        assert!(logs["entries"][0]["duration_ms"].is_null());
        assert_eq!(logs["entries"][0]["level"], "error");
        assert_eq!(
            get(
                &ui,
                "/api/logs?kind=log&level=error&node=svc:api&status=error"
            )
            .await["entries"]
                .as_array()
                .unwrap()
                .len(),
            1
        );
        assert_eq!(
            get(&ui, "/api/logs?q=STARTED&level=info").await["entries"]
                .as_array()
                .unwrap()
                .len(),
            1
        );
        let stats = get(&ui, "/api/stats").await;
        assert_eq!(stats["requests_stored"], 0);
        assert_eq!(stats["logs_received"], 3);
        assert_eq!(stats["logs_rejected"], 1);
        assert_eq!(get(&ui, "/api/graph").await["edges"], json!([]));
    }
}

#[tokio::test]
async fn log_store_evicts_by_time_and_bytes_and_reset_clears_it() {
    let mut limits = Limits::default();
    limits.store.max_log_bytes = 2_000;
    limits.store.max_log_entries = 2;
    let (otlp, ui) = app(limits);
    for time in [20, 30, 10] {
        assert_eq!(
            send(
                &otlp,
                "/v1/logs",
                "application/json",
                batch(json!([record(time, "hello")]))
                    .to_string()
                    .into_bytes()
            )
            .await
            .0,
            StatusCode::OK
        );
    }
    let logs = get(&ui, "/api/logs?limit=1").await;
    assert_eq!(logs["entries"][0]["time"], "30");
    let cursor = logs["next_before"].as_str().unwrap();
    assert_eq!(
        get(&ui, &format!("/api/logs?before={cursor}")).await["entries"][0]["time"],
        "20"
    );
    send(
        &otlp,
        "/v1/logs",
        "application/json",
        batch(json!([record(40, &"x".repeat(50_000))]))
            .to_string()
            .into_bytes(),
    )
    .await;
    let stats = get(&ui, "/api/stats").await;
    assert!(stats["log_bytes"].as_u64().unwrap() <= 2_000);
    assert!(stats["logs_evicted"].as_u64().unwrap() >= 3);
    assert_eq!(
        send(&ui, "/api/reset", "application/json", vec![]).await.0,
        StatusCode::NO_CONTENT
    );
    assert_eq!(get(&ui, "/api/stats").await["log_bytes"], 0);
}

#[tokio::test]
async fn record_limits_preserve_redaction_and_mark_truncation() {
    let (otlp, ui) = app(Limits::default());
    let mut entry = record(1, &"é".repeat(50_000));
    entry["attributes"] = json!([
        {"key":"password","value":{"stringValue":"fake-secret"}},
        {"key":"lens.log.kind","value":{"stringValue":"action"}}
    ]);
    send(
        &otlp,
        "/v1/logs",
        "application/json",
        batch(json!([entry])).to_string().into_bytes(),
    )
    .await;
    let logs = get(&ui, "/api/logs").await;
    assert_eq!(logs["entries"][0]["record"]["truncated"], true);
    assert_eq!(logs["entries"][0]["kind"], "action");
    assert!(
        logs["entries"][0]["record"]["attributes"]
            .to_string()
            .contains("lens.redaction.count")
    );
    assert!(logs["entries"][0]["record"]["body"].as_str().unwrap().len() <= 16_384);
    assert!(!logs.to_string().contains("fake-secret"));
}

#[tokio::test]
async fn log_ingest_uses_the_same_http_limits_and_cors_as_traces() {
    let (otlp, ui) = app(Limits::default());
    assert_eq!(
        send(&otlp, "/v1/logs", "text/plain", vec![]).await.0,
        StatusCode::UNSUPPORTED_MEDIA_TYPE
    );
    let (_, body) = send(
        &otlp,
        "/v1/logs",
        "application/json",
        br#"{"resourceLogs":"fake-secret"}"#.to_vec(),
    )
    .await;
    assert!(!String::from_utf8(body).unwrap().contains("fake-secret"));
    let forbidden = otlp
        .oneshot(
            Request::post("/v1/logs")
                .header("origin", "https://not-allowed.test")
                .header("content-type", "application/json")
                .body(Body::from("{}"))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(forbidden.status(), StatusCode::FORBIDDEN);
    for filter in ["level=oops", "kind=oops"] {
        let response = ui
            .clone()
            .oneshot(
                Request::get(format!("/api/logs?{filter}"))
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::BAD_REQUEST);
    }
    let mut limits = Limits::default();
    limits.http.max_body_bytes = 2;
    assert_eq!(
        send(
            &app(limits).0,
            "/v1/logs",
            "application/json",
            b"{  }".to_vec()
        )
        .await
        .0,
        StatusCode::PAYLOAD_TOO_LARGE
    );
    limits.http.max_concurrent_ingest = 0;
    assert_eq!(
        send(
            &app(limits).0,
            "/v1/logs",
            "application/json",
            b"{}".to_vec()
        )
        .await
        .0,
        StatusCode::SERVICE_UNAVAILABLE
    );
}

#[tokio::test]
async fn app_log_arriving_before_its_span_joins_the_edge_and_is_announced_by_sse() {
    let (otlp, ui) = app(Limits::default());
    let stream = ui
        .clone()
        .oneshot(Request::get("/api/events").body(Body::empty()).unwrap())
        .await
        .unwrap();
    let mut stream = stream.into_body();
    let trace = "a".repeat(32);
    let mut entry = record(100, "handled note");
    entry["traceId"] = json!(trace);
    entry["spanId"] = json!("2222222222222222");
    send(
        &otlp,
        "/v1/logs",
        "application/json",
        batch(json!([entry])).to_string().into_bytes(),
    )
    .await;
    let mut received = String::new();
    for _ in 0..2 {
        let frame = tokio::time::timeout(std::time::Duration::from_secs(1), stream.frame())
            .await
            .unwrap()
            .unwrap()
            .unwrap();
        received.push_str(std::str::from_utf8(&frame.into_data().unwrap()).unwrap());
    }
    assert!(received.contains("event: log"));
    assert!(received.contains("handled note"));
    let path = "/api/logs?edge=svc:web-%3Esvc:api&kind=log";
    assert_eq!(get(&ui, path).await["entries"], json!([]));
    let traces = json!({"resourceSpans":[
        {"resource":{"attributes":[{"key":"service.name","value":{"stringValue":"web"}}]},"scopeSpans":[{"spans":[{"traceId":trace,"spanId":"1111111111111111","kind":3,"name":"GET","startTimeUnixNano":"90","endTimeUnixNano":"120"}]}]},
        {"resource":{"attributes":[{"key":"service.name","value":{"stringValue":"api"}}]},"scopeSpans":[{"spans":[{"traceId":trace,"spanId":"2222222222222222","parentSpanId":"1111111111111111","kind":2,"name":"GET /notes","startTimeUnixNano":"95","endTimeUnixNano":"110"}]}]}
    ]});
    send(
        &otlp,
        "/v1/traces",
        "application/json",
        traces.to_string().into_bytes(),
    )
    .await;
    assert_eq!(get(&ui, path).await["entries"][0]["text"], "handled note");
    assert_eq!(get(&ui, "/api/graph").await["edges"][0]["count"], 1);
}
