// Core
use std::future::Future;
use std::pin::Pin;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::task::{Context as TaskContext, Poll};

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
    tracer: Option<SdkTracer>,
    check_database_events: bool,
    warned: Arc<AtomicBool>,
}

impl HttpLayer {
    pub(crate) fn new(tracer: Option<SdkTracer>, check_database_events: bool) -> Self {
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
    S: Service<Request<ReqBody>, Response = Response<ResBody>>,
    S::Future: Send + 'static,
    S::Error: 'static,
{
    type Response = S::Response;
    type Error = S::Error;
    type Future = Pin<Box<dyn Future<Output = Result<Self::Response, Self::Error>> + Send>>;

    fn poll_ready(&mut self, cx: &mut TaskContext<'_>) -> Poll<Result<(), Self::Error>> {
        self.inner.poll_ready(cx)
    }

    fn call(&mut self, request: Request<ReqBody>) -> Self::Future {
        let Some(tracer) = &self.layer.tracer else {
            return Box::pin(self.inner.call(request));
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
        if let Some(query) = request.uri().query() {
            attributes.push(KeyValue::new(URL_QUERY, query.to_owned()));
        }
        let span = tracer
            .span_builder(name)
            .with_kind(SpanKind::Server)
            .with_attributes(attributes)
            .start_with_context(tracer, &parent);
        let cx = parent.with_span(span);

        // The handler runs inside the span's context, so sqlx query events find their parent (ADR-0008).
        let response = self.inner.call(request).with_context(cx.clone());
        Box::pin(async move {
            let result = response.await;
            let span = cx.span();
            match &result {
                Ok(response) => {
                    let code = response.status().as_u16();
                    span.set_attribute(KeyValue::new(HTTP_RESPONSE_STATUS_CODE, i64::from(code)));
                    if code >= 500 {
                        span.set_status(Status::error(""));
                    }
                }
                Err(_) => span.set_status(Status::error("the service failed")),
            }
            span.end();
            result
        })
    }
}
