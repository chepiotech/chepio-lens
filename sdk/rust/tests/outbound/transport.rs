//! Real hyper HTTP and tonic HTTP/2 transport compatibility.

// Core
use std::convert::Infallible;
use std::future::Future;
use std::pin::Pin;
use std::task::{Context, Poll};
use std::time::Duration;

use axum::body::Body;
use axum::http::{Request, Response, uri::PathAndQuery};
use hyper_util::client::legacy::Client;
use hyper_util::rt::TokioExecutor;
use tokio::net::TcpListener;
use tonic::codec::{Codec, DecodeBuf, Decoder, EncodeBuf, Encoder};
use tonic::codegen::tokio_stream::wrappers::TcpListenerStream;
use tonic::server::NamedService;
use tower::{Layer, Service, ServiceExt};
// Utils
use super::{METHOD, METHODS, attribute, collect, parent, setup};
use opentelemetry::context::FutureExt;

#[tokio::test]
async fn hyper_client_reaches_an_axum_server_with_one_linked_trace() {
    let (client_lens, client_spans) = setup("gateway");
    let (server_lens, server_spans) = setup("http-service");
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let app = axum::Router::new()
        .route("/hello", axum::routing::get(|| async { "hello" }))
        .layer(server_lens.http_layer());
    let (shutdown, stopped) = tokio::sync::oneshot::channel::<()>();
    let task = tokio::spawn(async move {
        axum::serve(listener, app)
            .with_graceful_shutdown(async {
                let _ = stopped.await;
            })
            .await
            .unwrap();
    });
    let client: Client<_, Body> = Client::builder(TokioExecutor::new()).build_http();
    let client = client_lens.client_layer().layer(client);
    let response = client
        .oneshot(
            Request::get(format!("http://{address}/hello"))
                .body(Body::empty())
                .unwrap(),
        )
        .with_context(parent(4))
        .await
        .unwrap();
    assert_eq!(collect(response.into_body()).await.unwrap().0, "hello");
    wait_for_span(&server_spans).await;
    let client = &client_spans.get_finished_spans().unwrap()[0];
    let server = &server_spans.get_finished_spans().unwrap()[0];
    assert_eq!(server.parent_span_id, client.span_context.span_id());
    assert_eq!(
        server.span_context.trace_id(),
        client.span_context.trace_id()
    );
    let _ = shutdown.send(());
    tokio::time::timeout(Duration::from_secs(5), task)
        .await
        .unwrap()
        .unwrap();
}

// A real tonic unary RPC with a zero-field message. It needs neither protoc nor a protobuf dependency.
#[derive(Clone, Copy, Default)]
struct EmptyCodec;
impl Encoder for EmptyCodec {
    type Item = ();
    type Error = tonic::Status;
    fn encode(&mut self, _: (), _: &mut EncodeBuf<'_>) -> Result<(), Self::Error> {
        Ok(())
    }
}
impl Decoder for EmptyCodec {
    type Item = ();
    type Error = tonic::Status;
    fn decode(&mut self, _: &mut DecodeBuf<'_>) -> Result<Option<()>, Self::Error> {
        Ok(Some(()))
    }
}
impl Codec for EmptyCodec {
    type Encode = ();
    type Decode = ();
    type Encoder = Self;
    type Decoder = Self;
    fn encoder(&mut self) -> Self {
        *self
    }
    fn decoder(&mut self) -> Self {
        *self
    }
}

#[derive(Clone)]
struct Identity;
impl NamedService for Identity {
    const NAME: &'static str = "school.Identity";
}
impl tonic::server::UnaryService<()> for Identity {
    type Response = ();
    type Future = std::future::Ready<Result<tonic::Response<()>, tonic::Status>>;
    fn call(&mut self, request: tonic::Request<()>) -> Self::Future {
        let result = if request.metadata().get("x-test-error").is_some() {
            Err(tonic::Status::internal("fake-rpc-error"))
        } else {
            Ok(tonic::Response::new(()))
        };
        std::future::ready(result)
    }
}
impl tonic::server::ServerStreamingService<()> for Identity {
    type Response = ();
    type ResponseStream =
        tonic::codegen::tokio_stream::Iter<std::array::IntoIter<Result<(), tonic::Status>, 2>>;
    type Future = std::future::Ready<Result<tonic::Response<Self::ResponseStream>, tonic::Status>>;
    fn call(&mut self, _: tonic::Request<()>) -> Self::Future {
        std::future::ready(Ok(tonic::Response::new(
            tonic::codegen::tokio_stream::iter([
                Ok(()),
                Err(tonic::Status::unavailable("fake-stream-error")),
            ]),
        )))
    }
}
impl Service<Request<tonic::body::Body>> for Identity {
    type Response = Response<tonic::body::Body>;
    type Error = Infallible;
    type Future = Pin<Box<dyn Future<Output = Result<Self::Response, Self::Error>> + Send>>;
    fn poll_ready(&mut self, _: &mut Context<'_>) -> Poll<Result<(), Self::Error>> {
        Poll::Ready(Ok(()))
    }
    fn call(&mut self, request: Request<tonic::body::Body>) -> Self::Future {
        let streaming = request.uri().path() == "/school.Identity/Watch";
        if !streaming {
            assert_eq!(request.uri().path(), format!("/{METHOD}"));
        }
        Box::pin(async move {
            let mut grpc = tonic::server::Grpc::new(EmptyCodec);
            Ok(if streaming {
                grpc.server_streaming(Identity, request).await
            } else {
                grpc.unary(Identity, request).await
            })
        })
    }
}

async fn wait_for_span(exporter: &opentelemetry_sdk::trace::InMemorySpanExporter) {
    tokio::time::timeout(Duration::from_secs(5), async {
        while exporter.get_finished_spans().unwrap().is_empty() {
            tokio::task::yield_now().await;
        }
    })
    .await
    .unwrap();
}

#[tokio::test]
async fn tonic_unary_error_then_success_preserves_rpc_status_and_parentage() {
    let (client_lens, client_spans) = setup("gateway");
    let (server_lens, server_spans) = setup("identity");
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let endpoint = format!("http://{}", listener.local_addr().unwrap());
    let (shutdown, stopped) = tokio::sync::oneshot::channel::<()>();
    let task = tokio::spawn(async move {
        tonic::transport::Server::builder()
            .layer(server_lens.http_layer().with_rpc_methods(METHODS))
            .add_service(Identity)
            .serve_with_incoming_shutdown(TcpListenerStream::new(listener), async {
                let _ = stopped.await;
            })
            .await
            .unwrap();
    });
    let channel = tonic::transport::Endpoint::from_shared(endpoint.clone())
        .unwrap()
        .timeout(Duration::from_secs(5))
        .connect()
        .await
        .unwrap();
    let channel = client_lens
        .client_layer()
        .with_endpoint(endpoint.parse().unwrap())
        .with_rpc_methods(METHODS)
        .layer(channel);
    let mut client = tonic::client::Grpc::new(channel);
    for fail in [true, false] {
        client.ready().await.unwrap();
        let mut request = tonic::Request::new(());
        if fail {
            request
                .metadata_mut()
                .insert("x-test-error", "yes".parse().unwrap());
        }
        let result = client
            .unary(
                request,
                PathAndQuery::from_static("/school.Identity/GetUser"),
                EmptyCodec,
            )
            .with_context(parent(5))
            .await;
        if fail {
            assert_eq!(result.unwrap_err().code(), tonic::Code::Internal);
        } else {
            result.unwrap();
        }
        wait_for_span(&server_spans).await;
        let clients = client_spans.get_finished_spans().unwrap();
        let servers = server_spans.get_finished_spans().unwrap();
        assert_eq!(clients.len(), 1);
        assert_eq!(servers.len(), 1);
        assert_eq!(servers[0].parent_span_id, clients[0].span_context.span_id());
        assert_eq!(
            servers[0].span_context.trace_id(),
            clients[0].span_context.trace_id()
        );
        for span in [&clients[0], &servers[0]] {
            assert_eq!(
                attribute(span, "rpc.response.status_code"),
                Some(if fail { "INTERNAL" } else { "OK" }.into())
            );
            assert_eq!(
                matches!(span.status, opentelemetry::trace::Status::Error { .. }),
                fail
            );
            assert!(!format!("{:?}", span.attributes).contains("fake-rpc-error"));
        }
        client_spans.reset();
        server_spans.reset();
    }
    client.ready().await.unwrap();
    let mut stream = client
        .server_streaming(
            tonic::Request::new(()),
            PathAndQuery::from_static("/school.Identity/Watch"),
            EmptyCodec,
        )
        .with_context(parent(6))
        .await
        .unwrap()
        .into_inner();
    assert!(
        client_spans.get_finished_spans().unwrap().is_empty(),
        "response headers do not finish a stream"
    );
    assert_eq!(stream.message().await.unwrap(), Some(()));
    assert_eq!(
        stream.message().await.unwrap_err().code(),
        tonic::Code::Unavailable
    );
    wait_for_span(&server_spans).await;
    let spans = client_spans.get_finished_spans().unwrap();
    assert_eq!(spans.len(), 1);
    assert_eq!(
        attribute(&spans[0], "rpc.response.status_code"),
        Some("UNAVAILABLE".into())
    );
    assert!(matches!(
        spans[0].status,
        opentelemetry::trace::Status::Error { .. }
    ));
    assert!(!format!("{:?}", spans[0].attributes).contains("fake-stream-error"));
    drop(stream);
    drop(client);
    let _ = shutdown.send(());
    tokio::time::timeout(Duration::from_secs(5), task)
        .await
        .unwrap()
        .unwrap();
}
