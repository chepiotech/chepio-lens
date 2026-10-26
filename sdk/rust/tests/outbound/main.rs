//! Client/server context, streaming lifetimes and failure isolation, independent of the transport.

// Core
use std::convert::Infallible;
use std::future::{pending, poll_fn};
use std::pin::Pin;

use axum::body::{Body, Bytes, HttpBody, to_bytes};
use axum::http::{HeaderMap, Request, Response};
use chepio_lens_sdk::{Config, Lens, init_with};
use opentelemetry::context::FutureExt;
use opentelemetry::trace::{
    SpanContext, SpanId, SpanKind, Status, TraceContextExt, TraceFlags, TraceId, TraceState,
};
use opentelemetry::{Context, Value};
use opentelemetry_sdk::trace::{InMemorySpanExporter, SpanData};
use tower::{Layer, Service, ServiceExt, service_fn};
// Types
use frames::{Frames, TestError};

mod frames;
mod transport;

const METHOD: &str = "school.Identity/GetUser";
const METHODS: &[&str] = &[METHOD];

fn setup(name: &str) -> (Lens, InMemorySpanExporter) {
    let exporter = InMemorySpanExporter::default();
    (Lens::with_exporter(name, exporter.clone()), exporter)
}

fn attribute(span: &SpanData, key: &str) -> Option<Value> {
    span.attributes
        .iter()
        .find(|kv| kv.key.as_str() == key)
        .map(|kv| kv.value.clone())
}

fn parent(id: u8) -> Context {
    Context::new().with_remote_span_context(SpanContext::new(
        TraceId::from_bytes([id; 16]),
        SpanId::from_bytes([id; 8]),
        TraceFlags::SAMPLED,
        true,
        TraceState::default(),
    ))
}

fn request() -> Request<Body> {
    Request::post(format!("/{METHOD}"))
        .header("content-type", "application/grpc+json")
        .header("authorization", "Bearer fake-token")
        .header("private-data", "fake-metadata")
        .body(Body::from("fake-request"))
        .unwrap()
}

async fn collect<B: HttpBody<Data = Bytes> + Unpin>(
    mut body: B,
) -> Result<(Bytes, HeaderMap), B::Error> {
    let mut data = Vec::new();
    let mut trailers = HeaderMap::new();
    while let Some(frame) = poll_fn(|cx| Pin::new(&mut body).poll_frame(cx)).await {
        let frame = frame?;
        if let Some(bytes) = frame.data_ref() {
            data.extend_from_slice(bytes);
        }
        if let Ok(headers) = frame.into_trailers() {
            trailers = headers;
        }
    }
    Ok((Bytes::from(data), trailers))
}

#[tokio::test]
async fn concurrent_calls_propagate_their_own_parent_and_capture_http_safely() {
    let (client, client_spans) = setup("gateway");
    let (server, server_spans) = setup("service");
    let service = service_fn(|req: Request<Body>| async move {
        assert_eq!(req.headers()["authorization"], "Bearer fake-token");
        let current = Context::current().span().span_context().clone();
        tokio::task::yield_now().await;
        assert_eq!(*Context::current().span().span_context(), current);
        assert_eq!(
            to_bytes(req.into_body(), 1024).await.unwrap(),
            "fake-request"
        );
        Ok::<_, Infallible>(
            Response::builder()
                .header("content-type", "application/json")
                .body(Body::from(r#"{"token":"fake-response"}"#))
                .unwrap(),
        )
    });
    let client = client
        .client_layer()
        .layer(server.http_layer().layer(service));
    let call = |id| {
        let client = client.clone();
        async move {
            let req =
                Request::post("https://user:fake-credential@api.test:8443/login?token=fake-query")
                    .header("authorization", "Bearer fake-token")
                    .body(Body::from("fake-request"))
                    .unwrap();
            let response = client.oneshot(req).await.unwrap();
            assert_eq!(
                collect(response.into_body()).await.unwrap().0,
                r#"{"token":"fake-response"}"#
            );
        }
        .with_context(parent(id))
    };
    tokio::join!(call(1), call(2));
    let clients = client_spans.get_finished_spans().unwrap();
    let servers = server_spans.get_finished_spans().unwrap();
    assert_eq!(clients.len(), 2);
    assert_eq!(servers.len(), 2);
    for client in clients {
        let server = servers
            .iter()
            .find(|server| server.parent_span_id == client.span_context.span_id())
            .unwrap();
        assert_eq!(
            server.span_context.trace_id(),
            client.span_context.trace_id()
        );
        assert_eq!(
            client.parent_span_id,
            SpanId::from_bytes([client.span_context.trace_id().to_bytes()[0]; 8])
        );
        assert_eq!(
            attribute(&client, "server.address"),
            Some("api.test".into())
        );
        assert_eq!(attribute(&client, "server.port"), Some(8443_i64.into()));
        assert_eq!(
            attribute(&client, "url.query"),
            Some("token=[REDACTED]".into())
        );
        assert_eq!(attribute(&client, "lens.http.request.body"), None);
        assert_eq!(
            attribute(&client, "lens.http.response.body"),
            Some(r#"{"token":"[REDACTED]"}"#.into())
        );
        assert!(!format!("{:?}", client.attributes).contains("fake-"));
    }
}

#[tokio::test]
async fn grpc_trailers_end_the_span_and_errors_do_not_stick_to_the_next_call() {
    let (client, client_spans) = setup("gateway");
    let (server, server_spans) = setup("identity");
    for code in [13, 0, 3] {
        let service = service_fn(move |req: Request<Body>| async move {
            assert_eq!(req.headers()["private-data"], "fake-metadata");
            assert_eq!(
                to_bytes(req.into_body(), 1024).await.unwrap(),
                "fake-request"
            );
            Ok::<_, Infallible>(
                Response::builder()
                    .header("content-type", "application/grpc+json")
                    .header("private-data", "fake-response-metadata")
                    .body(Frames::grpc(code, true))
                    .unwrap(),
            )
        });
        let client = client
            .client_layer()
            .with_endpoint("https://identity.test:50051".parse().unwrap())
            .with_rpc_methods(METHODS)
            .layer(server.http_layer().with_rpc_methods(METHODS).layer(service));
        let response = client.oneshot(request()).await.unwrap();
        assert_eq!(response.status(), 200);
        assert!(client_spans.get_finished_spans().unwrap().is_empty());
        let (data, trailers) = collect(response.into_body()).await.unwrap();
        assert_eq!(data, "fake-response");
        assert_eq!(trailers["grpc-status"], code.to_string());
        assert_eq!(trailers["grpc-message"], "fake-error-message");
        for (spans, is_client) in [(&client_spans, true), (&server_spans, false)] {
            let spans = spans.get_finished_spans().unwrap();
            assert_eq!(spans.len(), 1);
            let span = &spans[0];
            assert_eq!(span.name, METHOD);
            assert_eq!(
                span.span_kind,
                if is_client {
                    SpanKind::Client
                } else {
                    SpanKind::Server
                }
            );
            assert_eq!(attribute(span, "rpc.system.name"), Some("grpc".into()));
            let status = match code {
                13 => "INTERNAL",
                3 => "INVALID_ARGUMENT",
                _ => "OK",
            };
            assert_eq!(
                attribute(span, "rpc.response.status_code"),
                Some(status.into())
            );
            assert_eq!(
                matches!(span.status, Status::Error { .. }),
                code == 13 || (is_client && code == 3)
            );
            assert!(!format!("{:?}", span.attributes).contains("fake-"));
        }
        client_spans.reset();
        server_spans.reset();
    }
}

#[tokio::test]
async fn trailers_only_and_unknown_methods_are_recorded_without_payloads() {
    let (lens, spans) = setup("client");
    let inner = service_fn(|_: Request<Body>| async {
        Ok::<_, Infallible>(
            Response::builder()
                .header("content-type", "application/grpc")
                .header("grpc-status", "7")
                .header("grpc-message", "fake-error-message")
                .body(Body::empty())
                .unwrap(),
        )
    });
    let response = lens
        .client_layer()
        .layer(inner)
        .oneshot(request())
        .await
        .unwrap();
    assert_eq!(response.headers()["grpc-status"], "7");
    let span = &spans.get_finished_spans().unwrap()[0];
    assert_eq!(attribute(span, "rpc.method"), Some("_OTHER".into()));
    assert_eq!(attribute(span, "rpc.method_original"), Some(METHOD.into()));
    assert_eq!(
        attribute(span, "rpc.response.status_code"),
        Some("PERMISSION_DENIED".into())
    );
    assert!(!format!("{:?}", span.attributes).contains("fake-"));
}

#[tokio::test]
async fn cancellation_transport_errors_and_body_errors_finish_once() {
    let (lens, spans) = setup("client");
    let inner = service_fn(|_: Request<Body>| pending::<Result<Response<Body>, TestError>>());
    let mut client = lens.client_layer().layer(inner);
    let future = client.call(request());
    drop(future);
    assert_eq!(
        attribute(&spans.get_finished_spans().unwrap()[0], "error.type"),
        Some("cancelled".into())
    );
    spans.reset();

    let inner = service_fn(|_: Request<Body>| async { Err::<Response<Body>, _>(TestError) });
    assert!(matches!(
        lens.client_layer().layer(inner).oneshot(request()).await,
        Err(TestError)
    ));
    assert_eq!(
        attribute(&spans.get_finished_spans().unwrap()[0], "error.type"),
        Some("transport.error".into())
    );
    spans.reset();

    for consume in [false, true] {
        let inner = service_fn(|_: Request<Body>| async {
            Ok::<_, Infallible>(Response::new(Frames::failed()))
        });
        let response = lens
            .client_layer()
            .layer(inner)
            .oneshot(request())
            .await
            .unwrap();
        if consume {
            assert!(matches!(
                collect(response.into_body()).await,
                Err(TestError)
            ));
        } else {
            drop(response);
        }
        let finished = spans.get_finished_spans().unwrap();
        assert_eq!(finished.len(), 1);
        assert_eq!(
            attribute(&finished[0], "error.type"),
            Some(if consume { "body.error" } else { "cancelled" }.into())
        );
        spans.reset();
    }
}

#[tokio::test]
async fn missing_and_invalid_grpc_status_are_not_successes() {
    for status in [None, Some("999"), Some("invalid"), Some("+0")] {
        let (lens, spans) = setup("client");
        let inner = service_fn(move |_: Request<Body>| async move {
            let mut response = Response::builder().body(Body::empty()).unwrap();
            if let Some(status) = status {
                response
                    .headers_mut()
                    .insert("grpc-status", status.parse().unwrap());
            }
            Ok::<_, Infallible>(response)
        });
        lens.client_layer()
            .layer(inner)
            .oneshot(request())
            .await
            .unwrap();
        let span = &spans.get_finished_spans().unwrap()[0];
        assert!(matches!(span.status, Status::Error { .. }));
        assert_eq!(attribute(span, "rpc.response.status_code"), None);
    }
}

#[tokio::test]
async fn disabled_layer_keeps_headers_bodies_and_errors_unchanged() {
    let lens = init_with(Config::default()).unwrap();
    let inner = service_fn(|req: Request<Body>| async move {
        assert_eq!(req.headers()["traceparent"], "existing-parent");
        assert_eq!(
            to_bytes(req.into_body(), 1024).await.unwrap(),
            "fake-request"
        );
        Ok::<_, Infallible>(Response::new(Frames::grpc(0, false)))
    });
    let mut req = request();
    req.headers_mut()
        .insert("traceparent", "existing-parent".parse().unwrap());
    let (data, trailers) = collect(
        lens.client_layer()
            .layer(inner)
            .oneshot(req)
            .await
            .unwrap()
            .into_body(),
    )
    .await
    .unwrap();
    assert_eq!(data, "fake-response");
    assert_eq!(trailers["grpc-status"], "0");
}

#[tokio::test]
async fn readiness_is_delegated_to_the_same_service_instance() {
    struct Ready(bool);
    impl Service<Request<&'static str>> for Ready {
        type Response = Response<Body>;
        type Error = TestError;
        type Future = std::future::Ready<Result<Self::Response, Self::Error>>;
        fn poll_ready(
            &mut self,
            _: &mut std::task::Context<'_>,
        ) -> std::task::Poll<Result<(), Self::Error>> {
            self.0 = true;
            std::task::Poll::Ready(Ok(()))
        }
        fn call(&mut self, request: Request<&'static str>) -> Self::Future {
            assert!(self.0);
            self.0 = false;
            assert_eq!(*request.body(), "unchanged concrete body");
            std::future::ready(Ok(Response::new(Body::empty())))
        }
    }
    let (lens, _) = setup("client");
    let response = lens
        .client_layer()
        .layer(Ready(false))
        .oneshot(Request::new("unchanged concrete body"))
        .await
        .unwrap();
    assert_eq!(response.status(), 200);
}
