//! What travelled on a hop, for the map's packet icons: protocol, operation, body types, status and error.

// Core
use chepio_lens_conventions::keys::{
    DB_OPERATION_NAME, DB_QUERY_TEXT, DB_SYSTEM_NAME, HTTP_REQUEST_BODY_SIZE, HTTP_REQUEST_METHOD,
    HTTP_RESPONSE_BODY_SIZE, HTTP_RESPONSE_STATUS_CODE, LENS_HTTP_REQUEST_BODY,
    LENS_HTTP_RESPONSE_BODY, URL_FULL, URL_SCHEME,
};
// Domain
use super::span::{AttrValue, Span};

/// Longest operation name kept; longer SQL keywords or HTTP methods are not real ones.
const MAX_OPERATION_CHARS: usize = 16;
const REQUEST_CONTENT_TYPE: &str = "http.request.header.content-type";
const RESPONSE_CONTENT_TYPE: &str = "http.response.header.content-type";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PacketKind {
    Http,
    Https,
    Sql,
}

/// What a request or response body holds, from its content type and size.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum BodyKind {
    None,
    Json,
    Form,
    Text,
    Binary,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Packet {
    pub kind: PacketKind,
    /// HTTP method or SQL operation, upper case.
    pub operation: Option<String>,
    pub request_body: BodyKind,
    pub response_body: BodyKind,
    pub status_code: Option<u16>,
    /// The edge's rule: the caller or the callee failed.
    pub error: bool,
}

impl Packet {
    /// From the hop's caller (client) span; the callee's server span, when it arrived, fills what the caller lacks.
    pub fn of(caller: &Span, callee: Option<&Span>) -> Self {
        let pick =
            |read: &dyn Fn(&Span) -> Option<String>| read(caller).or_else(|| callee.and_then(read));
        let error = caller.is_error() || callee.is_some_and(Span::is_error);
        if caller.attributes.contains_key(DB_SYSTEM_NAME) {
            return Self {
                kind: PacketKind::Sql,
                operation: sql_operation(caller),
                request_body: BodyKind::None,
                response_body: BodyKind::None,
                status_code: None,
                error,
            };
        }
        let scheme = pick(&|span| {
            span.attr_str(URL_SCHEME).map(str::to_owned).or_else(|| {
                span.attr_str(URL_FULL)
                    .and_then(|url| url.split_once("://"))
                    .map(|(scheme, _)| scheme.to_owned())
            })
        });
        let side = |span: &Span, content_type: &str, size: &str, body: &str| {
            span.attributes.contains_key(content_type)
                || span.attributes.contains_key(size)
                || span.attributes.contains_key(body)
        };
        // Each body from the span that recorded it: the caller when it did, else the callee.
        let request = [Some(caller), callee].into_iter().flatten().find(|span| {
            side(
                span,
                REQUEST_CONTENT_TYPE,
                HTTP_REQUEST_BODY_SIZE,
                LENS_HTTP_REQUEST_BODY,
            )
        });
        let response = [Some(caller), callee].into_iter().flatten().find(|span| {
            side(
                span,
                RESPONSE_CONTENT_TYPE,
                HTTP_RESPONSE_BODY_SIZE,
                LENS_HTTP_RESPONSE_BODY,
            )
        });
        Self {
            kind: match scheme.as_deref().map(str::to_ascii_lowercase).as_deref() {
                Some("https") => PacketKind::Https,
                _ => PacketKind::Http,
            },
            operation: pick(&|span| span.attr_str(HTTP_REQUEST_METHOD).and_then(operation_name)),
            request_body: request.map_or(BodyKind::None, |span| {
                body_kind(
                    span,
                    REQUEST_CONTENT_TYPE,
                    HTTP_REQUEST_BODY_SIZE,
                    LENS_HTTP_REQUEST_BODY,
                )
            }),
            response_body: response.map_or(BodyKind::None, |span| {
                body_kind(
                    span,
                    RESPONSE_CONTENT_TYPE,
                    HTTP_RESPONSE_BODY_SIZE,
                    LENS_HTTP_RESPONSE_BODY,
                )
            }),
            status_code: [Some(caller), callee]
                .into_iter()
                .flatten()
                .find_map(|span| span.attr_i64(HTTP_RESPONSE_STATUS_CODE))
                .and_then(|code| u16::try_from(code).ok()),
            error,
        }
    }
}

/// `db.operation.name`, else the first keyword of the query text.
fn sql_operation(span: &Span) -> Option<String> {
    span.attr_str(DB_OPERATION_NAME)
        .and_then(operation_name)
        .or_else(|| {
            span.attr_str(DB_QUERY_TEXT)
                .and_then(|query| query.split_whitespace().next())
                .and_then(operation_name)
        })
}

/// Upper case; `None` unless it is one short word of letters.
fn operation_name(word: &str) -> Option<String> {
    let word = word.trim();
    let valid = !word.is_empty()
        && word.chars().count() <= MAX_OPERATION_CHARS
        && word.chars().all(|c| c.is_ascii_alphabetic());
    valid.then(|| word.to_ascii_uppercase())
}

fn body_kind(span: &Span, content_type: &str, size: &str, body: &str) -> BodyKind {
    let has_text = span.attributes.contains_key(body);
    match span.attr_i64(size) {
        Some(0) if !has_text => return BodyKind::None,
        _ => {}
    }
    let media = span
        .attributes
        .get(content_type)
        .and_then(first_text)
        .map(|value| {
            value
                .split(';')
                .next()
                .unwrap_or_default()
                .trim()
                .to_ascii_lowercase()
        });
    match media.as_deref() {
        Some(media) if media == "application/json" || media.ends_with("+json") => BodyKind::Json,
        Some("application/x-www-form-urlencoded" | "multipart/form-data") => BodyKind::Form,
        Some(media) if media.starts_with("text/") => BodyKind::Text,
        Some(_) if has_text || span.attr_i64(size).is_some_and(|size| size > 0) => BodyKind::Binary,
        Some(_) => BodyKind::None,
        // No content type: captured text is text, a known size is bytes of unknown kind.
        None if has_text => BodyKind::Text,
        None if span.attr_i64(size).is_some_and(|size| size > 0) => BodyKind::Binary,
        None => BodyKind::None,
    }
}

/// Header attributes are string arrays (semconv); a plain string is accepted too.
fn first_text(value: &AttrValue) -> Option<&str> {
    match value {
        AttrValue::Str(text) => Some(text),
        AttrValue::Array(items) => items.first().and_then(AttrValue::as_str),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    // Core
    use super::*;
    use crate::domain::linker::tests;
    use crate::domain::span::{SpanKind, Status};

    fn span(kind: SpanKind, attributes: &[(&str, AttrValue)]) -> Span {
        tests::span("svc", kind, 1, None, attributes)
    }

    fn text(value: &str) -> AttrValue {
        AttrValue::Str(value.into())
    }

    fn header(value: &str) -> AttrValue {
        AttrValue::Array(vec![text(value)])
    }

    #[test]
    fn a_browser_post_with_json_both_ways_is_an_http_document_pair() {
        let fetch = span(
            SpanKind::Client,
            &[
                (URL_FULL, text("http://localhost:5173/api/notes")),
                (HTTP_REQUEST_METHOD, text("POST")),
                (
                    REQUEST_CONTENT_TYPE,
                    header("application/json; charset=utf-8"),
                ),
                (HTTP_RESPONSE_STATUS_CODE, AttrValue::Int(201)),
                (RESPONSE_CONTENT_TYPE, header("application/json")),
                (HTTP_RESPONSE_BODY_SIZE, AttrValue::Int(42)),
            ],
        );

        assert_eq!(
            Packet::of(&fetch, None),
            Packet {
                kind: PacketKind::Http,
                operation: Some("POST".into()),
                request_body: BodyKind::Json,
                response_body: BodyKind::Json,
                status_code: Some(201),
                error: false,
            }
        );
    }

    #[test]
    fn the_callee_fills_what_the_caller_did_not_record() {
        let fetch = span(
            SpanKind::Client,
            &[(URL_FULL, text("https://api.example.test/upload"))],
        );
        let server = span(
            SpanKind::Server,
            &[
                (HTTP_REQUEST_METHOD, text("put")),
                (REQUEST_CONTENT_TYPE, header("application/octet-stream")),
                (HTTP_REQUEST_BODY_SIZE, AttrValue::Int(2048)),
                (HTTP_RESPONSE_STATUS_CODE, AttrValue::Int(204)),
                (HTTP_RESPONSE_BODY_SIZE, AttrValue::Int(0)),
            ],
        );

        let packet = Packet::of(&fetch, Some(&server));
        assert_eq!(packet.kind, PacketKind::Https);
        assert_eq!(packet.operation.as_deref(), Some("PUT"));
        assert_eq!(packet.request_body, BodyKind::Binary);
        assert_eq!(packet.response_body, BodyKind::None);
        assert_eq!(packet.status_code, Some(204));
    }

    #[test]
    fn body_kinds_follow_the_content_type_and_size() {
        let kind = |attributes: &[(&str, AttrValue)]| {
            body_kind(
                &span(SpanKind::Server, attributes),
                REQUEST_CONTENT_TYPE,
                HTTP_REQUEST_BODY_SIZE,
                LENS_HTTP_REQUEST_BODY,
            )
        };
        assert_eq!(
            kind(&[(REQUEST_CONTENT_TYPE, header("application/problem+json"))]),
            BodyKind::Json
        );
        assert_eq!(
            kind(&[(
                REQUEST_CONTENT_TYPE,
                header("application/x-www-form-urlencoded")
            )]),
            BodyKind::Form
        );
        assert_eq!(
            kind(&[(
                REQUEST_CONTENT_TYPE,
                header("multipart/form-data; boundary=x")
            )]),
            BodyKind::Form
        );
        assert_eq!(
            kind(&[(REQUEST_CONTENT_TYPE, text("text/plain"))]),
            BodyKind::Text
        );
        assert_eq!(
            kind(&[
                (REQUEST_CONTENT_TYPE, header("image/png")),
                (HTTP_REQUEST_BODY_SIZE, AttrValue::Int(10))
            ]),
            BodyKind::Binary
        );
        assert_eq!(
            kind(&[
                (REQUEST_CONTENT_TYPE, header("application/json")),
                (HTTP_REQUEST_BODY_SIZE, AttrValue::Int(0))
            ]),
            BodyKind::None
        );
        assert_eq!(
            kind(&[(LENS_HTTP_REQUEST_BODY, text("hello"))]),
            BodyKind::Text
        );
        assert_eq!(
            kind(&[(HTTP_REQUEST_BODY_SIZE, AttrValue::Int(7))]),
            BodyKind::Binary
        );
        assert_eq!(kind(&[]), BodyKind::None);
    }

    #[test]
    fn a_query_is_sql_with_its_operation_and_errors_follow_the_edge_rule() {
        let query = span(
            SpanKind::Client,
            &[
                (DB_SYSTEM_NAME, text("postgresql")),
                (
                    DB_QUERY_TEXT,
                    text("  insert into notes (text) values ($1)"),
                ),
            ],
        );
        let packet = Packet::of(&query, None);
        assert_eq!(packet.kind, PacketKind::Sql);
        assert_eq!(packet.operation.as_deref(), Some("INSERT"));
        assert!(!packet.error);

        let failed = Span {
            status: Status::Error {
                message: "relation does not exist".into(),
            },
            ..span(
                SpanKind::Client,
                &[
                    (DB_SYSTEM_NAME, text("postgresql")),
                    (DB_OPERATION_NAME, text("select")),
                ],
            )
        };
        let packet = Packet::of(&failed, None);
        assert_eq!(packet.operation.as_deref(), Some("SELECT"));
        assert!(packet.error);

        let fetch = span(SpanKind::Client, &[(URL_FULL, text("http://api/fail"))]);
        let server = span(
            SpanKind::Server,
            &[(HTTP_RESPONSE_STATUS_CODE, AttrValue::Int(500))],
        );
        assert!(Packet::of(&fetch, Some(&server)).error);
    }

    #[test]
    fn odd_operations_are_dropped_rather_than_shown() {
        assert_eq!(operation_name("SELECT"), Some("SELECT".into()));
        assert_eq!(operation_name("(SELECT"), None);
        assert_eq!(operation_name(&"A".repeat(17)), None);
        assert_eq!(operation_name(""), None);
    }
}
