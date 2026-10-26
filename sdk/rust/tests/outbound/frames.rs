// Core
use std::collections::VecDeque;
use std::pin::Pin;
use std::task::{Context, Poll};

use axum::body::Bytes;
use axum::http::HeaderMap;
use http_body::{Body, Frame};
use opentelemetry::trace::{SpanId, TraceContextExt};

#[derive(Debug)]
pub struct TestError;
impl std::fmt::Display for TestError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("fake-body-error")
    }
}
impl std::error::Error for TestError {}

pub struct Frames {
    frames: VecDeque<Result<Frame<Bytes>, TestError>>,
    context: Option<SpanId>,
}

impl Frames {
    pub fn grpc(status: u16, check_context: bool) -> Self {
        let mut trailers = HeaderMap::new();
        trailers.insert("grpc-status", status.to_string().parse().unwrap());
        trailers.insert("grpc-message", "fake-error-message".parse().unwrap());
        Self {
            frames: VecDeque::from([
                Ok(Frame::data(Bytes::from_static(b"fake-response"))),
                Ok(Frame::trailers(trailers)),
            ]),
            context: check_context.then(|| {
                opentelemetry::Context::current()
                    .span()
                    .span_context()
                    .span_id()
            }),
        }
    }
    pub fn failed() -> Self {
        Self {
            frames: VecDeque::from([Err(TestError)]),
            context: None,
        }
    }
}

impl Body for Frames {
    type Data = Bytes;
    type Error = TestError;
    fn poll_frame(
        mut self: Pin<&mut Self>,
        _: &mut Context<'_>,
    ) -> Poll<Option<Result<Frame<Bytes>, TestError>>> {
        if let Some(id) = self.context {
            assert_eq!(
                opentelemetry::Context::current()
                    .span()
                    .span_context()
                    .span_id(),
                id
            );
        }
        Poll::Ready(self.frames.pop_front())
    }
    fn is_end_stream(&self) -> bool {
        self.frames.is_empty()
    }
}
