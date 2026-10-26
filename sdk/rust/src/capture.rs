//! Header and body capture for HTTP client/server spans (`docs/architecture/security.md`, "Body capture"). Bodies are redacted
//! whole and then cut: JSON cut at the limit no longer parses, so its keys could not be masked.

// Core
use std::pin::Pin;
use std::sync::{Arc, Mutex, PoisonError};
use std::task::{Context as TaskContext, Poll};

use axum::body::{Bytes, HttpBody};
use axum::http::header::{CONTENT_LENGTH, CONTENT_TYPE};
use axum::http::{HeaderMap, StatusCode};
use chepio_lens_conventions::redaction::{Redacted, Redactor};
use http_body::{Frame, SizeHint};
use opentelemetry::trace::{SpanKind, Status, TraceContextExt};
use opentelemetry::{Array, Context, KeyValue, StringValue, Value};
// Domain
use crate::rpc::is_grpc;
use chepio_lens_conventions::grpc;
// Consts
use chepio_lens_conventions::keys::{
    ERROR_TYPE, HTTP_REQUEST_BODY_SIZE, HTTP_REQUEST_HEADER_PREFIX, HTTP_RESPONSE_BODY_SIZE,
    HTTP_RESPONSE_HEADER_PREFIX, HTTP_RESPONSE_STATUS_CODE, LENS_HTTP_REQUEST_BODY,
    LENS_HTTP_REQUEST_BODY_TRUNCATED, LENS_HTTP_RESPONSE_BODY, LENS_HTTP_RESPONSE_BODY_TRUNCATED,
    LENS_REDACTION_COUNT, RPC_RESPONSE_STATUS_CODE,
};

/// The most of one body kept for redaction; a larger body is recorded by size only.
pub(crate) const REDACT_BUFFER: usize = 256 * 1024;
/// `CHEPIO_LENS_BODY_LIMIT` default: the most of a redacted body exported.
pub(crate) const DEFAULT_BODY_LIMIT: usize = 16 * 1024;

#[derive(Debug, Clone)]
pub(crate) struct CaptureConfig {
    pub bodies: bool,
    pub body_limit: usize,
    pub redactor: Redactor,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Side {
    Request,
    Response,
}

impl Side {
    fn header_prefix(self) -> &'static str {
        match self {
            Side::Request => HTTP_REQUEST_HEADER_PREFIX,
            Side::Response => HTTP_RESPONSE_HEADER_PREFIX,
        }
    }

    fn keys(self) -> (&'static str, &'static str, &'static str) {
        match self {
            Side::Request => (
                HTTP_REQUEST_BODY_SIZE,
                LENS_HTTP_REQUEST_BODY,
                LENS_HTTP_REQUEST_BODY_TRUNCATED,
            ),
            Side::Response => (
                HTTP_RESPONSE_BODY_SIZE,
                LENS_HTTP_RESPONSE_BODY,
                LENS_HTTP_RESPONSE_BODY_TRUNCATED,
            ),
        }
    }
}

/// How a captured body is masked; other content types are recorded by size only.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum TextKind {
    Json,
    Form,
    Plain,
}

fn text_kind(headers: &HeaderMap) -> Option<TextKind> {
    let content_type = headers.get(CONTENT_TYPE)?.to_str().ok()?;
    let mime = content_type.split(';').next()?.trim().to_ascii_lowercase();
    if mime == "application/json" || mime.ends_with("+json") {
        Some(TextKind::Json)
    } else if mime == "application/x-www-form-urlencoded" {
        Some(TextKind::Form)
    } else if mime.starts_with("text/") {
        Some(TextKind::Plain)
    } else {
        None
    }
}

/// Every header as `<prefix><name>`, a string array as in the OpenTelemetry conventions, sensitive values masked.
pub(crate) fn header_attributes(
    side: Side,
    headers: &HeaderMap,
    redactor: &Redactor,
) -> (Vec<KeyValue>, usize) {
    let mut count = 0;
    let attributes = headers
        .keys()
        .map(|name| {
            let values = headers
                .get_all(name)
                .iter()
                .map(|value| {
                    let text = String::from_utf8_lossy(value.as_bytes());
                    let redacted = redactor.redact_header(name.as_str(), &text);
                    count += redacted.count;
                    StringValue::from(redacted.text)
                })
                .collect();
            KeyValue::new(
                format!("{}{name}", side.header_prefix()),
                Value::Array(Array::String(values)),
            )
        })
        .collect();
    (attributes, count)
}

/// What one body showed while it streamed through.
#[derive(Debug, Default)]
struct Recorded {
    kind: Option<TextKind>,
    content_length: Option<u64>,
    kept: Vec<u8>,
    seen: u64,
    /// The body was read at all.
    observed: bool,
    complete: bool,
    /// More than `REDACT_BUFFER` bytes: too large to redact, so no text is kept.
    overflow: bool,
}

impl Recorded {
    fn new(headers: &HeaderMap, bodies: bool) -> Self {
        Self {
            kind: if bodies { text_kind(headers) } else { None },
            content_length: headers
                .get(CONTENT_LENGTH)
                .and_then(|value| value.to_str().ok())
                .and_then(|value| value.parse().ok()),
            ..Self::default()
        }
    }

    fn record(&mut self, data: &[u8]) {
        self.observed = true;
        self.seen += data.len() as u64;
        if self.kind.is_none() || self.overflow {
            return;
        }
        if self.kept.len() + data.len() > REDACT_BUFFER {
            self.overflow = true;
            self.kept = Vec::new();
        } else {
            self.kept.extend_from_slice(data);
        }
    }

    /// Size, then the redacted and cut text when the whole body was seen and is small enough to redact.
    fn attributes(&self, side: Side, config: &CaptureConfig) -> (Vec<KeyValue>, usize) {
        let (size_key, body_key, truncated_key) = side.keys();
        let mut attributes = Vec::new();
        if let Some(size) = if self.complete {
            Some(self.seen)
        } else {
            self.content_length
        } {
            attributes.push(KeyValue::new(
                size_key,
                i64::try_from(size).unwrap_or(i64::MAX),
            ));
        }
        let Some(kind) = self.kind else {
            return (attributes, 0);
        };
        if !self.observed || self.seen == 0 {
            return (attributes, 0);
        }
        if !self.complete || self.overflow {
            attributes.push(KeyValue::new(truncated_key, true));
            return (attributes, 0);
        }
        let text = String::from_utf8_lossy(&self.kept);
        let redacted = match kind {
            TextKind::Json => config
                .redactor
                .redact_json(&text)
                .unwrap_or_else(|| unchanged(&text)),
            TextKind::Form => config.redactor.redact_form(&text),
            TextKind::Plain => unchanged(&text),
        };
        let (cut, truncated) = cut(&redacted.text, config.body_limit);
        attributes.push(KeyValue::new(body_key, cut.to_owned()));
        attributes.push(KeyValue::new(truncated_key, truncated));
        (attributes, redacted.count)
    }
}

fn unchanged(text: &str) -> Redacted {
    Redacted {
        text: text.to_owned(),
        count: 0,
    }
}

/// Cuts `text` to at most `limit` bytes at a character boundary.
fn cut(text: &str, limit: usize) -> (&str, bool) {
    if text.len() <= limit {
        return (text, false);
    }
    let mut end = limit;
    while !text.is_char_boundary(end) {
        end -= 1;
    }
    (&text[..end], true)
}

/// One request and its response. The span ends once, when the response body finishes or is dropped.
pub(crate) struct Exchange {
    config: Arc<CaptureConfig>,
    grpc: bool,
    client: bool,
    state: Mutex<State>,
}

struct State {
    cx: Option<Context>,
    request: Recorded,
    response: Recorded,
    redactions: usize,
    grpc_status: Option<&'static str>,
    failed: bool,
}

impl Exchange {
    /// `redactions`: values already masked on the span (URL query).
    pub(crate) fn new(
        cx: Context,
        config: Arc<CaptureConfig>,
        request_headers: &HeaderMap,
        redactions: usize,
        kind: SpanKind,
    ) -> Arc<Self> {
        let grpc = is_grpc(request_headers);
        let (headers, header_redactions) = if grpc {
            (Vec::new(), 0)
        } else {
            header_attributes(Side::Request, request_headers, &config.redactor)
        };
        cx.span().set_attributes(headers);
        Arc::new(Self {
            state: Mutex::new(State {
                cx: Some(cx),
                request: Recorded::new(request_headers, config.bodies && !grpc),
                response: Recorded::default(),
                redactions: redactions + header_redactions,
                grpc_status: None,
                failed: false,
            }),
            config,
            grpc,
            client: kind == SpanKind::Client,
        })
    }

    fn state(&self) -> std::sync::MutexGuard<'_, State> {
        self.state.lock().unwrap_or_else(PoisonError::into_inner)
    }

    pub(crate) fn response_started(&self, status: StatusCode, headers: &HeaderMap) {
        let (mut attributes, redactions) = if self.grpc {
            (Vec::new(), 0)
        } else {
            header_attributes(Side::Response, headers, &self.config.redactor)
        };
        attributes.push(KeyValue::new(
            HTTP_RESPONSE_STATUS_CODE,
            i64::from(status.as_u16()),
        ));
        let mut state = self.state();
        state.response = Recorded::new(headers, self.config.bodies && !self.grpc);
        state.redactions += redactions;
        if let Some(cx) = &state.cx {
            cx.span().set_attributes(attributes);
        }
        drop(state);
        if status.is_server_error() || (self.client && status.is_client_error()) {
            self.fail("http.status_error");
        }
        self.trailers(headers);
    }

    fn context(&self) -> Context {
        self.state().cx.clone().unwrap_or_default()
    }

    fn trailers(&self, headers: &HeaderMap) {
        if !self.grpc {
            return;
        }
        let Some(value) = headers.get("grpc-status") else {
            return;
        };
        let status = value
            .to_str()
            .ok()
            .filter(|code| !code.is_empty() && code.bytes().all(|byte| byte.is_ascii_digit()))
            .and_then(|code| code.parse::<u16>().ok())
            .and_then(grpc::status_name);
        let Some(status) = status else {
            self.fail("grpc.invalid_status");
            return;
        };
        let mut state = self.state();
        state.grpc_status = Some(status);
        if let Some(cx) = &state.cx {
            cx.span()
                .set_attribute(KeyValue::new(RPC_RESPONSE_STATUS_CODE, status));
        }
        drop(state);
        if grpc::is_error(status, self.client) {
            self.fail(status);
        }
    }

    pub(crate) fn fail(&self, category: &'static str) {
        let mut state = self.state();
        if !state.failed
            && let Some(cx) = &state.cx
        {
            cx.span().set_status(Status::error(""));
            cx.span().set_attribute(KeyValue::new(ERROR_TYPE, category));
            state.failed = true;
        }
    }

    fn record(&self, side: Side, data: &[u8]) {
        let mut state = self.state();
        match side {
            Side::Request => state.request.record(data),
            Side::Response => state.response.record(data),
        }
    }

    fn finish(&self, side: Side) {
        let mut state = self.state();
        match side {
            Side::Request => state.request.complete = true,
            Side::Response => state.response.complete = true,
        }
    }

    /// Sets the body attributes and ends the span; later calls do nothing.
    pub(crate) fn end(&self) {
        let mut state = self.state();
        if self.grpc
            && state.grpc_status.is_none()
            && !state.failed
            && let Some(cx) = &state.cx
        {
            cx.span().set_status(Status::error(""));
            cx.span()
                .set_attribute(KeyValue::new(ERROR_TYPE, "grpc.missing_status"));
        }
        let Some(cx) = state.cx.take() else {
            return;
        };
        let (request, request_redactions) = state.request.attributes(Side::Request, &self.config);
        let (response, response_redactions) =
            state.response.attributes(Side::Response, &self.config);
        let redactions = state.redactions + request_redactions + response_redactions;
        drop(state);
        let span = cx.span();
        span.set_attributes(request.into_iter().chain(response));
        if redactions > 0 {
            span.set_attribute(KeyValue::new(
                LENS_REDACTION_COUNT,
                i64::try_from(redactions).unwrap_or(i64::MAX),
            ));
        }
        span.end();
    }
}

/// Passes response frames and errors through unchanged while observing span lifetime.
/// Constructed by the SDK's Tower layers; no payload is retained when instrumentation is disabled.
pub struct ObservedBody<B: HttpBody<Data = Bytes>> {
    inner: Pin<Box<B>>,
    exchange: Option<Arc<Exchange>>,
    side: Side,
    finished: bool,
}

impl<B: HttpBody<Data = Bytes>> ObservedBody<B> {
    pub(crate) fn new(inner: B, exchange: Arc<Exchange>, side: Side) -> Self {
        let mut body = Self {
            inner: Box::pin(inner),
            exchange: Some(exchange),
            side,
            finished: false,
        };
        if body.inner.is_end_stream() {
            body.complete();
        }
        body
    }

    pub(crate) fn passthrough(inner: B) -> Self {
        Self {
            inner: Box::pin(inner),
            exchange: None,
            side: Side::Response,
            finished: false,
        }
    }

    fn complete(&mut self) {
        self.finished = true;
        if let Some(exchange) = &self.exchange {
            exchange.finish(self.side);
            if self.side == Side::Response {
                exchange.end();
            }
        }
    }
}

impl<B: HttpBody<Data = Bytes> + Default> Default for ObservedBody<B> {
    fn default() -> Self {
        Self::passthrough(B::default())
    }
}

impl<B: HttpBody<Data = Bytes>> HttpBody for ObservedBody<B> {
    type Data = Bytes;
    type Error = B::Error;

    fn poll_frame(
        mut self: Pin<&mut Self>,
        cx: &mut TaskContext<'_>,
    ) -> Poll<Option<Result<Frame<Bytes>, B::Error>>> {
        let this = &mut *self;
        if this.finished {
            return Poll::Ready(None);
        }
        let _guard = this
            .exchange
            .as_ref()
            .map(|exchange| exchange.context().attach());
        let poll = this.inner.as_mut().poll_frame(cx);
        match &poll {
            Poll::Ready(Some(Ok(frame))) => {
                if let Some(exchange) = &this.exchange {
                    if let Some(data) = frame.data_ref() {
                        exchange.record(this.side, data);
                    }
                    if this.side == Side::Response
                        && let Some(trailers) = frame.trailers_ref()
                    {
                        exchange.trailers(trailers);
                    }
                }
                // A trailer frame is terminal; consumers need not poll once more after it.
                if this.inner.is_end_stream() || frame.trailers_ref().is_some() {
                    this.complete();
                }
            }
            Poll::Ready(None) => this.complete(),
            Poll::Ready(Some(Err(_))) => {
                if let Some(exchange) = &this.exchange {
                    exchange.fail("body.error");
                    if this.side == Side::Response {
                        exchange.end();
                    }
                }
                this.finished = true;
            }
            Poll::Pending => {}
        }
        poll
    }

    fn is_end_stream(&self) -> bool {
        self.finished || self.inner.is_end_stream()
    }
    fn size_hint(&self) -> SizeHint {
        self.inner.size_hint()
    }
}

impl<B: HttpBody<Data = Bytes>> Drop for ObservedBody<B> {
    fn drop(&mut self) {
        if !self.finished
            && let Some(exchange) = &self.exchange
        {
            if self.inner.is_end_stream() {
                exchange.finish(self.side);
            } else if self.side == Side::Response {
                exchange.fail("cancelled");
            }
            if self.side == Side::Response {
                exchange.end();
            }
        }
    }
}

/// Owned before the response future is polled, so dropping even an unpolled call closes its span.
pub(crate) struct ResponseGuard(pub Option<Arc<Exchange>>);

impl Drop for ResponseGuard {
    fn drop(&mut self) {
        if let Some(exchange) = self.0.take() {
            exchange.fail("cancelled");
            exchange.end();
        }
    }
}

#[cfg(test)]
mod tests {
    // Core
    use axum::http::HeaderValue;

    use super::*;

    fn config(limit: usize) -> CaptureConfig {
        CaptureConfig {
            bodies: true,
            body_limit: limit,
            redactor: Redactor::default(),
        }
    }

    fn recorded(content_type: &str, chunks: &[&[u8]], complete: bool) -> Recorded {
        let mut headers = HeaderMap::new();
        headers.insert(CONTENT_TYPE, HeaderValue::from_str(content_type).unwrap());
        let mut recorded = Recorded::new(&headers, true);
        for chunk in chunks {
            recorded.record(chunk);
        }
        recorded.complete = complete;
        recorded
    }

    fn text(attributes: &[KeyValue], key: &str) -> Option<String> {
        attributes
            .iter()
            .find(|kv| kv.key.as_str() == key)
            .map(|kv| kv.value.as_str().into_owned())
    }

    #[test]
    fn content_types_decide_how_a_body_is_masked() {
        let kind = |value: &str| {
            let mut headers = HeaderMap::new();
            headers.insert(CONTENT_TYPE, HeaderValue::from_str(value).unwrap());
            text_kind(&headers)
        };
        assert_eq!(
            kind("application/json; charset=utf-8"),
            Some(TextKind::Json)
        );
        assert_eq!(kind("application/problem+json"), Some(TextKind::Json));
        assert_eq!(
            kind("application/x-www-form-urlencoded"),
            Some(TextKind::Form)
        );
        assert_eq!(kind("text/plain"), Some(TextKind::Plain));
        assert_eq!(kind("image/png"), None);
        assert_eq!(text_kind(&HeaderMap::new()), None);
    }

    /// A password past the cut would be masked anyway; one before it must be too, though the cut JSON is invalid.
    #[test]
    fn json_is_masked_whole_before_it_is_cut() {
        let body = br#"{"password":"demo-password","text":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"}"#;
        let recorded = recorded("application/json", &[&body[..10], &body[10..]], true);

        let (attributes, count) = recorded.attributes(Side::Request, &config(30));

        assert_eq!(count, 1);
        assert_eq!(
            text(&attributes, LENS_HTTP_REQUEST_BODY).as_deref(),
            Some(r#"{"password":"[REDACTED]","text"#)
        );
        assert_eq!(
            text(&attributes, LENS_HTTP_REQUEST_BODY_TRUNCATED).as_deref(),
            Some("true")
        );
        assert_eq!(
            text(&attributes, HTTP_REQUEST_BODY_SIZE).as_deref(),
            Some(body.len().to_string().as_str())
        );
    }

    #[test]
    fn bodies_too_large_to_redact_or_not_read_to_the_end_keep_no_text() {
        let chunk = vec![b'a'; REDACT_BUFFER];
        let large = recorded("text/plain", &[&chunk, b"b"], true);
        let partial = recorded("application/json", &[br#"{"password":"x"#], false);

        for (recorded, side) in [(large, Side::Response), (partial, Side::Request)] {
            let (attributes, _) = recorded.attributes(side, &config(DEFAULT_BODY_LIMIT));
            let (_, body_key, truncated_key) = side.keys();
            assert_eq!(text(&attributes, body_key), None);
            assert_eq!(text(&attributes, truncated_key).as_deref(), Some("true"));
        }
    }

    #[test]
    fn cuts_happen_at_character_boundaries() {
        assert_eq!(cut("абв", 3), ("а", true));
        assert_eq!(cut("abc", 3), ("abc", false));
    }

    #[test]
    fn other_content_types_and_unread_bodies_give_only_their_size() {
        let image = recorded("image/png", &[b"\x89PNG"], true);
        let (attributes, _) = image.attributes(Side::Response, &config(DEFAULT_BODY_LIMIT));
        assert_eq!(
            text(&attributes, HTTP_RESPONSE_BODY_SIZE).as_deref(),
            Some("4")
        );
        assert_eq!(text(&attributes, LENS_HTTP_RESPONSE_BODY), None);

        let unread = recorded("application/json", &[], false);
        assert!(
            unread
                .attributes(Side::Request, &config(DEFAULT_BODY_LIMIT))
                .0
                .is_empty()
        );
    }

    #[test]
    fn sensitive_headers_are_masked_and_repeated_headers_kept() {
        let mut headers = HeaderMap::new();
        headers.insert("authorization", HeaderValue::from_static("Bearer t"));
        headers.append("accept", HeaderValue::from_static("text/html"));
        headers.append("accept", HeaderValue::from_static("application/json"));

        let (attributes, count) = header_attributes(Side::Request, &headers, &Redactor::default());

        assert_eq!(count, 1);
        let value = |key: &str| {
            attributes
                .iter()
                .find(|kv| kv.key.as_str() == key)
                .map(|kv| kv.value.clone())
        };
        assert_eq!(
            value("http.request.header.authorization"),
            Some(Value::Array(Array::String(vec!["[REDACTED]".into()])))
        );
        assert_eq!(
            value("http.request.header.accept"),
            Some(Value::Array(Array::String(vec![
                "text/html".into(),
                "application/json".into()
            ])))
        );
    }
}
