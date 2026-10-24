//! Second redaction pass on ingest (I2, ADR-0004): covers spans from stock OpenTelemetry exporters and anything an
//! SDK missed. Uses the same rules as the SDKs (`chepio_lens_conventions::redaction`).

// Core
use chepio_lens_conventions::keys::{
    HTTP_REQUEST_HEADER_PREFIX, HTTP_RESPONSE_HEADER_PREFIX, LENS_HTTP_REQUEST_BODY,
    LENS_HTTP_RESPONSE_BODY, LENS_REDACTION_COUNT, URL_FULL, URL_QUERY,
};
use chepio_lens_conventions::redaction::{Redacted, Redactor};
// Domain
use crate::domain::span::{AttrValue, Span};

const FORM_CONTENT_TYPE: &str = "application/x-www-form-urlencoded";

/// Masks headers, URL query parameters and bodies in place; adds what it masked to `lens.redaction.count`.
pub(crate) fn redact_span(span: &mut Span, redactor: &Redactor) -> usize {
    let is_form = |prefix: &str, span: &Span| {
        let key = format!("{prefix}content-type");
        let value = span.attributes.get(&key);
        let text = match value {
            Some(AttrValue::Str(text)) => Some(text.as_str()),
            Some(AttrValue::Array(items)) => items.first().and_then(AttrValue::as_str),
            _ => None,
        };
        text.is_some_and(|text| text.to_ascii_lowercase().contains(FORM_CONTENT_TYPE))
    };
    let request_form = is_form(HTTP_REQUEST_HEADER_PREFIX, span);
    let response_form = is_form(HTTP_RESPONSE_HEADER_PREFIX, span);

    let mut count = 0;
    for (key, value) in span.attributes.iter_mut() {
        let header = key
            .strip_prefix(HTTP_REQUEST_HEADER_PREFIX)
            .or_else(|| key.strip_prefix(HTTP_RESPONSE_HEADER_PREFIX));
        count += match (header, key.as_str()) {
            (Some(name), _) => map_strings(value, &|text| redactor.redact_header(name, text)),
            (None, URL_FULL) => map_strings(value, &|text| redactor.redact_url(text)),
            (None, URL_QUERY) => map_strings(value, &|text| redactor.redact_form(text)),
            (None, LENS_HTTP_REQUEST_BODY) => {
                map_strings(value, &|text| redact_body(redactor, text, request_form))
            }
            (None, LENS_HTTP_RESPONSE_BODY) => {
                map_strings(value, &|text| redact_body(redactor, text, response_form))
            }
            _ => 0,
        };
    }
    if count > 0 {
        let previous = span.attr_i64(LENS_REDACTION_COUNT).unwrap_or(0);
        span.attributes.insert(
            LENS_REDACTION_COUNT.to_owned(),
            AttrValue::Int(previous + i64::try_from(count).unwrap_or(i64::MAX)),
        );
    }
    count
}

/// JSON bodies are masked by key; form bodies by field; other text is kept (`security.md`).
fn redact_body(redactor: &Redactor, body: &str, is_form: bool) -> Redacted {
    match redactor.redact_json(body) {
        Some(redacted) => redacted,
        None if is_form => redactor.redact_form(body),
        None => Redacted {
            text: body.to_owned(),
            count: 0,
        },
    }
}

/// Applies `redact` to a string value or to each string of an array (headers are string arrays in semconv).
fn map_strings(value: &mut AttrValue, redact: &dyn Fn(&str) -> Redacted) -> usize {
    match value {
        AttrValue::Str(text) => {
            let redacted = redact(text);
            *text = redacted.text;
            redacted.count
        }
        AttrValue::Array(items) => items.iter_mut().map(|item| map_strings(item, redact)).sum(),
        _ => 0,
    }
}

#[cfg(test)]
mod tests {
    // Core
    use super::*;
    use crate::domain::linker::tests::span;
    use crate::domain::span::SpanKind;

    #[test]
    fn headers_urls_and_bodies_are_masked_and_counted() {
        let mut span = span(
            "api",
            SpanKind::Server,
            1,
            None,
            &[
                (
                    "http.request.header.authorization",
                    AttrValue::Array(vec![AttrValue::Str("Bearer x".into())]),
                ),
                (
                    "http.request.header.accept",
                    AttrValue::Array(vec![AttrValue::Str("*/*".into())]),
                ),
                (
                    URL_FULL,
                    AttrValue::Str("http://api/login?token=abc".into()),
                ),
                (
                    LENS_HTTP_REQUEST_BODY,
                    AttrValue::Str(r#"{"username":"demo","password":"demo-password"}"#.into()),
                ),
                (
                    LENS_HTTP_RESPONSE_BODY,
                    AttrValue::Str(r#"{"token":"demo-session-token"}"#.into()),
                ),
                (LENS_REDACTION_COUNT, AttrValue::Int(1)),
            ],
        );

        assert_eq!(redact_span(&mut span, &Redactor::default()), 4);

        assert_eq!(
            span.attributes["http.request.header.authorization"],
            AttrValue::Array(vec![AttrValue::Str("[REDACTED]".into())])
        );
        assert_eq!(
            span.attributes["http.request.header.accept"],
            AttrValue::Array(vec![AttrValue::Str("*/*".into())])
        );
        assert_eq!(
            span.attr_str(URL_FULL),
            Some("http://api/login?token=[REDACTED]")
        );
        assert_eq!(
            span.attr_str(LENS_HTTP_REQUEST_BODY),
            Some(r#"{"username":"demo","password":"[REDACTED]"}"#)
        );
        assert_eq!(
            span.attr_str(LENS_HTTP_RESPONSE_BODY),
            Some(r#"{"token":"[REDACTED]"}"#)
        );
        assert_eq!(
            span.attr_i64(LENS_REDACTION_COUNT),
            Some(5),
            "adds to the SDK's count"
        );
    }

    #[test]
    fn form_bodies_are_masked_only_with_a_form_content_type() {
        let body = "user=demo&password=secret";
        let mut form = span(
            "api",
            SpanKind::Server,
            1,
            None,
            &[
                (
                    "http.request.header.content-type",
                    AttrValue::Str("application/x-www-form-urlencoded".into()),
                ),
                (LENS_HTTP_REQUEST_BODY, AttrValue::Str(body.into())),
            ],
        );
        let mut text = span(
            "api",
            SpanKind::Server,
            2,
            None,
            &[(LENS_HTTP_REQUEST_BODY, AttrValue::Str(body.into()))],
        );

        assert_eq!(redact_span(&mut form, &Redactor::default()), 1);
        assert_eq!(redact_span(&mut text, &Redactor::default()), 0);
        assert_eq!(
            form.attr_str(LENS_HTTP_REQUEST_BODY),
            Some("user=demo&password=[REDACTED]")
        );
        assert_eq!(text.attr_str(LENS_HTTP_REQUEST_BODY), Some(body));
        assert!(!text.attributes.contains_key(LENS_REDACTION_COUNT));
    }
}
