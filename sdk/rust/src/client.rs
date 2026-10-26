//! Outbound instrumentation for Tower HTTP clients, including hyper and tonic channels (ADR-0015).

// Core
use std::future::Future;
use std::pin::Pin;
use std::sync::Arc;
use std::task::{Context as TaskContext, Poll};

use axum::body::{Bytes, HttpBody};
use axum::http::{Request, Response, Uri};
use opentelemetry::context::FutureExt;
use opentelemetry::propagation::TextMapPropagator;
use opentelemetry::trace::{SpanKind, TraceContextExt, Tracer};
use opentelemetry::{Context, KeyValue};
use opentelemetry_http::HeaderInjector;
use opentelemetry_sdk::propagation::TraceContextPropagator;
use opentelemetry_sdk::trace::SdkTracer;
use tower::{Layer, Service};
// Domain
use crate::capture::{CaptureConfig, Exchange, ObservedBody, ResponseGuard, Side};
use crate::rpc;
// Consts
use chepio_lens_conventions::keys::{
    HTTP_REQUEST_METHOD, SERVER_ADDRESS, SERVER_PORT, URL_PATH, URL_QUERY, URL_SCHEME,
};

#[derive(Clone)]
pub struct ClientLayer {
    tracer: Option<(SdkTracer, Arc<CaptureConfig>)>,
    endpoint: Option<Uri>,
    rpc_methods: &'static [&'static str],
}

impl ClientLayer {
    pub(crate) fn new(tracer: Option<(SdkTracer, Arc<CaptureConfig>)>) -> Self {
        Self {
            tracer,
            endpoint: None,
            rpc_methods: &[],
        }
    }

    /// The channel's endpoint when it fills the URI after this layer (tonic). Never changes the actual destination.
    /// Only scheme, host and port are recorded; credentials, path and query are ignored.
    pub fn with_endpoint(mut self, endpoint: Uri) -> Self {
        self.endpoint = Some(endpoint);
        self
    }

    /// Recognized qualified gRPC methods, e.g. `package.Service/Call` (RPC semantic conventions).
    pub fn with_rpc_methods(mut self, methods: &'static [&'static str]) -> Self {
        self.rpc_methods = methods;
        self
    }
}

impl<S> Layer<S> for ClientLayer {
    type Service = ClientService<S>;
    fn layer(&self, inner: S) -> Self::Service {
        ClientService {
            inner,
            layer: self.clone(),
        }
    }
}

#[derive(Clone)]
pub struct ClientService<S> {
    inner: S,
    layer: ClientLayer,
}

impl<S, ReqBody, ResBody> Service<Request<ReqBody>> for ClientService<S>
where
    S: Service<Request<ReqBody>, Response = Response<ResBody>>,
    S::Future: Send + 'static,
    S::Error: 'static,
    ResBody: HttpBody<Data = Bytes> + Send + 'static,
{
    type Response = Response<ObservedBody<ResBody>>;
    type Error = S::Error;
    type Future = Pin<Box<dyn Future<Output = Result<Self::Response, Self::Error>> + Send>>;

    fn poll_ready(&mut self, cx: &mut TaskContext<'_>) -> Poll<Result<(), Self::Error>> {
        self.inner.poll_ready(cx)
    }

    fn call(&mut self, mut request: Request<ReqBody>) -> Self::Future {
        let Some((tracer, capture)) = &self.layer.tracer else {
            let response = self.inner.call(request);
            return Box::pin(async move { Ok(response.await?.map(ObservedBody::passthrough)) });
        };
        let grpc = rpc::is_grpc(request.headers());
        let (name, mut attributes) = if grpc {
            rpc::attributes(request.uri(), self.layer.rpc_methods)
        } else {
            (
                request.method().to_string(),
                vec![
                    KeyValue::new(HTTP_REQUEST_METHOD, request.method().to_string()),
                    KeyValue::new(URL_PATH, request.uri().path().to_owned()),
                ],
            )
        };
        let endpoint = if request.uri().host().is_some() {
            request.uri()
        } else {
            self.layer.endpoint.as_ref().unwrap_or(request.uri())
        };
        if let Some(host) = endpoint.host() {
            attributes.push(KeyValue::new(SERVER_ADDRESS, host.to_owned()));
        }
        let scheme = endpoint.scheme_str();
        if let Some(scheme) = scheme {
            attributes.push(KeyValue::new(URL_SCHEME, scheme.to_owned()));
        }
        if let Some(port) = endpoint.port_u16().or(match scheme {
            Some("https") => Some(443),
            Some("http") => Some(80),
            _ => None,
        }) {
            attributes.push(KeyValue::new(SERVER_PORT, i64::from(port)));
        }
        let mut redactions = 0;
        if !grpc && let Some(query) = request.uri().query() {
            let query = capture.redactor.redact_form(query);
            redactions += query.count;
            attributes.push(KeyValue::new(URL_QUERY, query.text));
        }
        let parent = Context::current();
        let cx = parent.with_span(
            tracer
                .span_builder(name)
                .with_kind(SpanKind::Client)
                .with_attributes(attributes)
                .start_with_context(tracer, &parent),
        );
        TraceContextPropagator::new()
            .inject_context(&cx, &mut HeaderInjector(request.headers_mut()));
        let exchange = Exchange::new(
            cx.clone(),
            capture.clone(),
            request.headers(),
            redactions,
            SpanKind::Client,
        );
        let mut guard = ResponseGuard(Some(exchange.clone()));
        // Both synchronous call-time work and subsequent polling see the client span.
        let response = {
            let _guard = cx.clone().attach();
            self.inner.call(request)
        }
        .with_context(cx);
        Box::pin(async move {
            match response.await {
                Ok(response) => {
                    exchange.response_started(response.status(), response.headers());
                    guard.0.take();
                    Ok(response.map(|body| ObservedBody::new(body, exchange, Side::Response)))
                }
                Err(error) => {
                    exchange.fail("transport.error");
                    exchange.end();
                    Err(error)
                }
            }
        })
    }
}
