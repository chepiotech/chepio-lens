//! I10: payload and attribute values never reach the collector's log, whatever the collector logs about a batch.

// Core
use std::io::Write;
use std::sync::{Arc, Mutex};

use axum::body::Body;
use axum::http::{Request, StatusCode, header};
use chepio_lens_collector::app::{Limits, build};
use chepio_lens_collector::handlers::otlp_router;
use tower::ServiceExt;
use tracing_subscriber::fmt::MakeWriter;

const MARKER: &str = "PAYLOAD-MARKER-7f3a";

/// Collects everything the collector logs in this test.
#[derive(Clone, Default)]
struct Captured(Arc<Mutex<Vec<u8>>>);

impl Write for Captured {
    fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
        self.0.lock().unwrap().extend_from_slice(bytes);
        Ok(bytes.len())
    }

    fn flush(&mut self) -> std::io::Result<()> {
        Ok(())
    }
}

impl<'a> MakeWriter<'a> for Captured {
    type Writer = Captured;

    fn make_writer(&'a self) -> Self::Writer {
        self.clone()
    }
}

fn span_with_payloads(trace: &str) -> String {
    let attribute = |key: &str, value: &str| {
        format!(r#"{{"key":"{key}","value":{{"stringValue":"{value}"}}}}"#)
    };
    let attributes = [
        attribute(
            "lens.http.request.body",
            &format!(r#"{{\"note\":\"{MARKER}\"}}"#),
        ),
        attribute("http.request.header.x-note", MARKER),
        attribute("url.query", &format!("q={MARKER}")),
        attribute("db.query.text", &format!("SELECT '{MARKER}'")),
    ]
    .join(",");
    format!(
        r#"{{"resourceSpans":[{{"resource":{{"attributes":[{{"key":"service.name","value":{{"stringValue":"api"}}}}]}},
        "scopeSpans":[{{"spans":[{{"traceId":"{trace}","spanId":"00f067aa0ba902b7","name":"POST /notes","kind":2,
        "startTimeUnixNano":"1","endTimeUnixNano":"2","attributes":[{attributes}],
        "events":[{{"name":"exception","timeUnixNano":"1","attributes":[{}]}}]}}]}}]}}]}}"#,
        attribute("exception.message", MARKER)
    )
}

#[tokio::test(flavor = "current_thread")]
async fn payload_values_never_reach_the_collector_log() {
    let captured = Captured::default();
    let subscriber = tracing_subscriber::fmt()
        .with_writer(captured.clone())
        .with_max_level(tracing::Level::TRACE)
        .finish();
    let _guard = tracing::subscriber::set_default(subscriber);
    let otlp = otlp_router(build(&[], &[], Limits::default()));
    let send = |body: String| {
        otlp.clone().oneshot(
            Request::post("/v1/traces")
                .header(header::CONTENT_TYPE, "application/json")
                .body(Body::from(body))
                .unwrap(),
        )
    };

    let accepted = send(span_with_payloads("4bf92f3577b34da6a3ce929d0e0e4736"))
        .await
        .unwrap();
    // Malformed batches are logged; their content must not be.
    let malformed = send(format!(r#"{{"resourceSpans":"{MARKER}"#))
        .await
        .unwrap();
    // The message of a failed decode must not quote the input either.
    let wrong_type = send(span_with_payloads(MARKER)).await.unwrap();

    assert_eq!(accepted.status(), StatusCode::OK);
    assert_eq!(malformed.status(), StatusCode::BAD_REQUEST);
    assert_eq!(
        wrong_type.status(),
        StatusCode::BAD_REQUEST,
        "a trace id that is not hex fails decoding"
    );
    for (body, expected) in [
        (
            format!(
                r#"{{"resourceLogs":[{{"scopeLogs":[{{"logRecords":[{{"body":{{"stringValue":"{MARKER}"}},"attributes":[{{"key":"note","value":{{"stringValue":"{MARKER}"}}}}]}}]}}]}}]}}"#
            ),
            StatusCode::OK,
        ),
        (
            format!(r#"{{"resourceLogs":"{MARKER}"}}"#),
            StatusCode::BAD_REQUEST,
        ),
    ] {
        let response = otlp
            .clone()
            .oneshot(
                Request::post("/v1/logs")
                    .header(header::CONTENT_TYPE, "application/json")
                    .body(Body::from(body))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), expected);
    }
    let log = String::from_utf8(captured.0.lock().unwrap().clone()).unwrap();
    assert!(
        log.contains("malformed OTLP export"),
        "the capture works: {log}"
    );
    assert!(
        !log.contains(MARKER),
        "a payload value reached the log: {log}"
    );
}
