// Core
use std::future::Future;
use std::pin::Pin;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::task::{Context as TaskContext, Poll};

use axum::BoxError;
use axum::body::{Body, Bytes, HttpBody};
use axum::extract::MatchedPath;
use axum::http::{Request, Response};
use opentelemetry::context::FutureExt;
use opentelemetry::propagation::TextMapPropagator;
use opentelemetry::trace::{SpanKind, Status, TraceContextExt, Tracer};
use opentelemetry::{Context, KeyValue};
use opentelemetry_http::HeaderExtractor;
use opentelemetry_sdk::propagation::TraceContextPropagator;
use opentelemetry_sdk::trace::SdkTracer;
use tower::{Layer, Service};
// Domain
use crate::capture::{CaptureConfig, Exchange, RecordingBody, Side};
use crate::lens::database_events_enabled;
// Consts
use chepio_lens_conventions::keys::{
    HTTP_REQUEST_METHOD, HTTP_RESPONSE_STATUS_CODE, HTTP_ROUTE, URL_PATH, URL_QUERY,
};

const DATABASE_EVENTS_OFF: &str = "chepio-lens: database spans are off because sqlx::query DEBUG events do not reach \
the chepio-lens tracing layer. Add lens.tracing_layer() to your tracing subscriber (or call lens.install_tracing()), \
and allow sqlx::query=debug if you use a global level filter.";

#[derive(Clone)]
pub struct HttpLayer {
    tracer: Option<(SdkTracer, Arc<CaptureConfig>)>,
    check_database_events: bool,
    warned: Arc<AtomicBool>,
}

impl HttpLayer {
    pub(crate) fn new(
        tracer: Option<(SdkTracer, Arc<CaptureConfig>)>,
        check_database_events: bool,
    ) -> Self {
        Self {
            tracer,
            check_database_events,
            warned: Arc::new(AtomicBool::new(false)),
        }
    }
}

impl<S> Layer<S> for HttpLayer {
    type Service = HttpService<S>;

    fn layer(&self, inner: S) -> Self::Service {
        HttpService {
            inner,
            layer: self.clone(),
        }
    }
}

#[derive(Clone)]
pub struct HttpService<S> {
    inner: S,
    layer: HttpLayer,
}

impl<S, ReqBody, ResBody> Service<Request<ReqBody>> for HttpService<S>
where
    S: Service<Request<Body>, Response = Response<ResBody>>,
    S::Future: Send + 'static,
    S::Error: 'static,
    ReqBody: HttpBody<Data = Bytes> + Send + 'static,
    ReqBody::Error: Into<BoxError>,
    ResBody: HttpBody<Data = Bytes> + Send + 'static,
    ResBody::Error: Into<BoxError>,
{
    type Response = Response<Body>;
    type Error = S::Error;
    type Future = Pin<Box<dyn Future<Output = Result<Self::Response, Self::Error>> + Send>>;

    fn poll_ready(&mut self, cx: &mut TaskContext<'_>) -> Poll<Result<(), Self::Error>> {
        self.inner.poll_ready(cx)
    }

    fn call(&mut self, request: Request<ReqBody>) -> Self::Future {
        let Some((tracer, capture)) = &self.layer.tracer else {
            let response = self.inner.call(request.map(Body::new));
            return Box::pin(async move { Ok(response.await?.map(Body::new)) });
        };
        if self.layer.check_database_events
            && !database_events_enabled()
            && !self.layer.warned.swap(true, Ordering::Relaxed)
        {
            eprintln!("{DATABASE_EVENTS_OFF}");
        }

        let parent = TraceContextPropagator::new()
            .extract_with_context(&Context::new(), &HeaderExtractor(request.headers()));
        let method = request.method().as_str().to_owned();
        let path = request.uri().path().to_owned();
        let route = request
            .extensions()
            .get::<MatchedPath>()
            .map(|route| route.as_str().to_owned());
        let name = format!("{method} {}", route.as_deref().unwrap_or(&path));
        let mut attributes = vec![
            KeyValue::new(HTTP_REQUEST_METHOD, method),
            KeyValue::new(URL_PATH, path),
        ];
        if let Some(route) = route {
            attributes.push(KeyValue::new(HTTP_ROUTE, route));
        }
        let mut redactions = 0;
        if let Some(query) = request.uri().query() {
            let query = capture.redactor.redact_form(query);
            redactions += query.count;
            attributes.push(KeyValue::new(URL_QUERY, query.text));
        }
        let span = tracer
            .span_builder(name)
            .with_kind(SpanKind::Server)
            .with_attributes(attributes)
            .start_with_context(tracer, &parent);
        let cx = parent.with_span(span);
        let exchange = Exchange::new(cx.clone(), capture.clone(), request.headers(), redactions);
        let request = request.map(|body| {
            Body::new(RecordingBody::new(
                Body::new(body),
                exchange.clone(),
                Side::Request,
            ))
        });

        // The handler runs inside the span's context, so sqlx query events find their parent (ADR-0008).
        let response = self.inner.call(request).with_context(cx.clone());
        Box::pin(async move {
            let result = response.await;
            let span = cx.span();
            match result {
                Ok(response) => {
                    let code = response.status().as_u16();
                    span.set_attribute(KeyValue::new(HTTP_RESPONSE_STATUS_CODE, i64::from(code)));
                    if code >= 500 {
                        span.set_status(Status::error(""));
                    }
                    exchange.response_started(response.headers());
                    // The span ends when this body has been sent or dropped, so its duration includes the body.
                    Ok(response.map(|body| {
                        Body::new(RecordingBody::new(
                            Body::new(body),
                            exchange,
                            Side::Response,
                        ))
                    }))
                }
                Err(error) => {
                    span.set_status(Status::error("the service failed"));
                    exchange.end();
                    Err(error)
                }
            }
        })
    }
}
