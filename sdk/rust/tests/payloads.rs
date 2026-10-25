//! Header and body capture in the axum layer: what is exported, and that the app sees its bodies unchanged.

// Core
use std::collections::HashMap;
use std::convert::Infallible;
use std::pin::Pin;
use std::task::{Context, Poll};

use axum::Router;
use axum::body::{Body, Bytes, to_bytes};
use axum::http::{Request, StatusCode, header};
use axum::routing::{get, post};
use chepio_lens_sdk::{Config, Lens};
use http_body::Frame;
use opentelemetry::{Array, Key, StringValue, Value};
use opentelemetry_sdk::trace::{InMemorySpanExporter, SpanData};
use tower::ServiceExt;

const LOGIN: &str = r#"{"username":"demo","password":"demo-password"}"#;
const TOKEN: &str = r#"{"token":"demo-session-token"}"#;

/// A response body that arrives in several frames, like a streamed response.
struct Chunks(Vec<&'static str>);

impl http_body::Body for Chunks {
    type Data = Bytes;
    type Error = Infallible;

    fn poll_frame(
        mut self: Pin<&mut Self>,
        _: &mut Context<'_>,
    ) -> Poll<Option<Result<Frame<Bytes>, Infallible>>> {
        Poll::Ready(if self.0.is_empty() {
            None
        } else {
            Some(Ok(Frame::data(Bytes::from_static(
                self.0.remove(0).as_bytes(),
            ))))
        })
    }
}

fn lens(config: Config) -> (Lens, InMemorySpanExporter) {
    let exporter = InMemorySpanExporter::default();
    let config = Config {
        service_name: "demo-api".into(),
        ..config
    };
    (
        Lens::with_exporter_config(config, exporter.clone()),
        exporter,
    )
}

fn app(lens: &Lens) -> Router {
    Router::new()
        .route(
            "/login",
            post(|body: String| async move {
                // The handler gets the original body, unmasked.
                assert_eq!(body, LOGIN);
                ([(header::CONTENT_TYPE, "application/json")], TOKEN)
            }),
        )
        .route(
            "/echo",
            post(|request: Request<Body>| async move {
                let content_type = request.headers()[header::CONTENT_TYPE].clone();
                let body = to_bytes(request.into_body(), usize::MAX).await.unwrap();
                ([(header::CONTENT_TYPE, content_type)], body)
            }),
        )
        .route("/ignore", post(|| async { "ignored" }))
        .route(
            "/stream",
            get(|| async {
                (
                    [(header::CONTENT_TYPE, "text/plain")],
                    Body::new(Chunks(vec!["one ", "two ", "three"])),
                )
            }),
        )
        .layer(lens.http_layer())
}

fn post_json(uri: &str, body: impl Into<Body>) -> Request<Body> {
    Request::post(uri)
        .header(header::CONTENT_TYPE, "application/json")
        .body(body.into())
        .unwrap()
}

/// Sends the request, reads the whole response like a server would, and returns its body and the one span.
async fn exchange(
    app: Router,
    request: Request<Body>,
    exporter: &InMemorySpanExporter,
) -> (Bytes, SpanData) {
    let response = app.oneshot(request).await.unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let body = to_bytes(response.into_body(), usize::MAX).await.unwrap();
    let mut spans = exporter.get_finished_spans().unwrap();
    assert_eq!(spans.len(), 1);
    (body, spans.remove(0))
}

fn attributes(span: &SpanData) -> HashMap<String, Value> {
    span.attributes
        .iter()
        .map(|kv| (kv.key.as_str().to_owned(), kv.value.clone()))
        .collect()
}

fn strings(values: &[&str]) -> Value {
    Value::Array(Array::String(
        values
            .iter()
            .map(|value| StringValue::from(value.to_string()))
            .collect(),
    ))
}

#[tokio::test]
async fn login_bodies_and_headers_are_exported_masked_while_the_app_sees_them_unchanged() {
    let (lens, exporter) = lens(Config::default());
    let request = Request::post("/login?token=abc&page=2")
        .header(header::CONTENT_TYPE, "application/json")
        .header(header::AUTHORIZATION, "Bearer secret")
        .body(Body::from(LOGIN))
        .unwrap();

    let (body, span) = exchange(app(&lens), request, &exporter).await;

    assert_eq!(body, TOKEN, "the client gets the original response");
    let attributes = attributes(&span);
    assert_eq!(
        attributes["lens.http.request.body"],
        r#"{"username":"demo","password":"[REDACTED]"}"#.into()
    );
    assert_eq!(
        attributes["lens.http.response.body"],
        r#"{"token":"[REDACTED]"}"#.into()
    );
    assert_eq!(attributes["lens.http.request.body.truncated"], false.into());
    assert_eq!(
        attributes["http.request.body.size"],
        (LOGIN.len() as i64).into()
    );
    assert_eq!(
        attributes["http.response.body.size"],
        (TOKEN.len() as i64).into()
    );
    assert_eq!(
        attributes["http.request.header.authorization"],
        strings(&["[REDACTED]"])
    );
    assert_eq!(
        attributes["http.request.header.content-type"],
        strings(&["application/json"])
    );
    assert_eq!(
        attributes["http.response.header.content-type"],
        strings(&["application/json"])
    );
    assert_eq!(attributes["url.query"], "token=[REDACTED]&page=2".into());
    // URL token, authorization header, password, response token.
    assert_eq!(attributes["lens.redaction.count"], 4_i64.into());
    let exported = format!("{:?}", span.attributes);
    for secret in [
        "demo-password",
        "demo-session-token",
        "Bearer secret",
        "abc",
    ] {
        assert!(!exported.contains(secret), "{secret} leaked: {exported}");
    }
}

#[tokio::test]
async fn streamed_responses_reach_the_client_unchanged_and_end_the_span_when_done() {
    let (lens, exporter) = lens(Config::default());

    let response = app(&lens)
        .oneshot(Request::get("/stream").body(Body::empty()).unwrap())
        .await
        .unwrap();
    assert!(
        exporter.get_finished_spans().unwrap().is_empty(),
        "the span waits for the body"
    );
    let body = to_bytes(response.into_body(), usize::MAX).await.unwrap();

    assert_eq!(body, "one two three");
    let span = &exporter.get_finished_spans().unwrap()[0];
    assert_eq!(
        attributes(span)["lens.http.response.body"],
        "one two three".into()
    );
}

#[tokio::test]
async fn long_bodies_are_cut_after_masking_and_huge_ones_keep_only_their_size() {
    let (lens, exporter) = lens(Config {
        body_limit: 40,
        ..Config::default()
    });
    let long = format!(r#"{{"secret":"s","text":"{}"}}"#, "a".repeat(100));

    let (body, span) = exchange(app(&lens), post_json("/echo", long.clone()), &exporter).await;

    assert_eq!(body, long);
    let attributes = attributes(&span);
    assert_eq!(
        attributes["lens.http.request.body"],
        r#"{"secret":"[REDACTED]","text":"aaaaaaaaa"#.into()
    );
    assert_eq!(attributes["lens.http.request.body.truncated"], true.into());

    exporter.reset();
    let huge = format!(r#"{{"text":"{}"}}"#, "a".repeat(300 * 1024));
    let (_, span) = exchange(app(&lens), post_json("/echo", huge.clone()), &exporter).await;
    let attributes = self::attributes(&span);
    assert!(!attributes.contains_key("lens.http.request.body"));
    assert_eq!(attributes["lens.http.request.body.truncated"], true.into());
    assert_eq!(
        attributes["http.request.body.size"],
        (huge.len() as i64).into()
    );
}

#[tokio::test]
async fn binary_bodies_unread_bodies_and_disabled_capture_export_no_text() {
    let (lens, exporter) = lens(Config::default());
    let binary = Request::post("/echo")
        .header(header::CONTENT_TYPE, "application/octet-stream")
        .body(Body::from(vec![0_u8, 159, 146, 150]))
        .unwrap();
    let (_, span) = exchange(app(&lens), binary, &exporter).await;
    let attributes = attributes(&span);
    assert!(!attributes.contains_key("lens.http.request.body"));
    assert_eq!(attributes["http.request.body.size"], 4_i64.into());

    exporter.reset();
    let (body, span) = exchange(app(&lens), post_json("/ignore", LOGIN), &exporter).await;
    assert_eq!(body, "ignored");
    let attributes = self::attributes(&span);
    assert!(!attributes.contains_key("lens.http.request.body"));
    assert!(!attributes.contains_key("lens.http.request.body.truncated"));

    let (lens, exporter) = self::lens(Config {
        capture_bodies: false,
        ..Config::default()
    });
    let (_, span) = exchange(app(&lens), post_json("/login", LOGIN), &exporter).await;
    let attributes = self::attributes(&span);
    assert!(!attributes.contains_key("lens.http.request.body"));
    assert!(!attributes.contains_key("lens.http.response.body"));
    assert!(attributes.contains_key("http.request.header.content-type"));
}

#[tokio::test]
async fn a_response_the_client_drops_still_ends_the_span() {
    let (lens, exporter) = lens(Config::default());

    let response = app(&lens)
        .oneshot(Request::get("/stream").body(Body::empty()).unwrap())
        .await
        .unwrap();
    drop(response);

    let span = &exporter.get_finished_spans().unwrap()[0];
    // Nothing of the body was sent, so there is nothing to show; the status is still known.
    assert!(!attributes(span).contains_key("lens.http.response.body"));
    assert!(
        span.attributes
            .iter()
            .any(|kv| kv.key == Key::from("http.response.status_code"))
    );
}

#[test]
fn settings_come_from_the_environment_and_bad_values_keep_the_defaults() {
    let vars = |pairs: &'static [(&'static str, &'static str)]| {
        move |name: &str| {
            pairs
                .iter()
                .find(|(key, _)| *key == name)
                .map(|(_, value)| (*value).to_owned())
        }
    };

    let config = Config::from_env(
        "demo-api",
        vars(&[
            ("CHEPIO_LENS_ENDPOINT", "http://localhost:4318"),
            ("CHEPIO_LENS_CAPTURE_BODIES", "false"),
            ("CHEPIO_LENS_BODY_LIMIT", "1024"),
            ("CHEPIO_LENS_REDACT_KEYS", " ssn, ,tenant "),
        ]),
    );
    assert_eq!(config.endpoint.as_deref(), Some("http://localhost:4318"));
    assert!(!config.capture_bodies);
    assert_eq!(config.body_limit, 1024);
    assert_eq!(config.redact_keys, ["ssn", "tenant"]);

    let defaults = Config::default();
    let bad = Config::from_env(
        "demo-api",
        vars(&[
            ("CHEPIO_LENS_CAPTURE_BODIES", "maybe"),
            ("CHEPIO_LENS_BODY_LIMIT", "lots"),
        ]),
    );
    assert_eq!(
        (bad.capture_bodies, bad.body_limit, bad.endpoint),
        (defaults.capture_bodies, defaults.body_limit, None)
    );
}
