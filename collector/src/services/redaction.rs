//! Second redaction pass on ingest (I2, ADR-0004): covers spans from stock OpenTelemetry exporters and anything an
//! SDK missed. Uses the same rules as the SDKs (`chepio_lens_conventions::redaction`).

// Core
use chepio_lens_conventions::keys::{
    HTTP_REQUEST_HEADER_PREFIX, HTTP_RESPONSE_HEADER_PREFIX, LENS_HTTP_REQUEST_BODY,
    LENS_HTTP_RESPONSE_BODY, LENS_REDACTION_COUNT, URL_FULL, URL_QUERY,
};
use chepio_lens_conventions::redaction::{REDACTED, Redacted, Redactor};
// Domain
use crate::domain::log_record::LogRecord;
use crate::domain::span::{AttrValue, Attributes, Span};

const FORM_CONTENT_TYPE: &str = "application/x-www-form-urlencoded";

/// Masks headers, URL query parameters and bodies in place, in the span's attributes and in its events' attributes;
/// adds what it masked to `lens.redaction.count`.
pub(crate) fn redact_span(span: &mut Span, redactor: &Redactor) -> usize {
    let forms = form_content_types(&span.attributes, (false, false));

    let mut count = redact_attributes(
        &mut span.attributes,
        &span.truncated_attributes,
        redactor,
        forms,
    );
    for event in &mut span.events {
        let event_forms = form_content_types(&event.attributes, forms);
        count += redact_attributes(
            &mut event.attributes,
            &event.truncated_attributes,
            redactor,
            event_forms,
        );
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

/// An event can describe its own request/response; missing content types inherit the containing span's choice.
fn form_content_types(attributes: &Attributes, fallback: (bool, bool)) -> (bool, bool) {
    let is_form = |prefix: &str, fallback: bool| {
        let key = format!("{prefix}content-type");
        let text = match attributes.get(&key) {
            Some(AttrValue::Str(text)) => Some(text.as_str()),
            Some(AttrValue::Array(items)) => items.first().and_then(AttrValue::as_str),
            _ => None,
        };
        text.map_or(fallback, |text| {
            text.split(';')
                .next()
                .is_some_and(|mime| mime.trim().eq_ignore_ascii_case(FORM_CONTENT_TYPE))
        })
    };
    (
        is_form(HTTP_REQUEST_HEADER_PREFIX, fallback.0),
        is_form(HTTP_RESPONSE_HEADER_PREFIX, fallback.1),
    )
}

/// `(request_form, response_form)`: whether the attributes' request and response bodies are forms, by content type.
fn redact_attributes(
    attributes: &mut Attributes,
    truncated_attributes: &[String],
    redactor: &Redactor,
    (request_form, response_form): (bool, bool),
) -> usize {
    let mut count = 0;
    for (key, value) in attributes.iter_mut() {
        let header = key
            .strip_prefix(HTTP_REQUEST_HEADER_PREFIX)
            .or_else(|| key.strip_prefix(HTTP_RESPONSE_HEADER_PREFIX));
        count += match (header, key.as_str()) {
            (Some(name), _) => map_strings(value, &|text| redactor.redact_header(name, text)),
            (None, URL_FULL) => map_strings(value, &|text| redactor.redact_url(text)),
            (None, URL_QUERY) => map_strings(value, &|text| redactor.redact_form(text)),
            // The decoder may have cut valid JSON into an unparseable prefix containing secrets. A body cut by
            // the collector cannot be masked reliably by key, so hide it whole and keep the truncation marker.
            (None, LENS_HTTP_REQUEST_BODY | LENS_HTTP_RESPONSE_BODY)
                if truncated_attributes.contains(key) =>
            {
                map_strings(value, &|text| Redacted {
                    text: REDACTED.to_owned(),
                    count: usize::from(text != REDACTED),
                })
            }
            (None, LENS_HTTP_REQUEST_BODY) => {
                map_strings(value, &|text| redact_body(redactor, text, request_form))
            }
            (None, LENS_HTTP_RESPONSE_BODY) => {
                map_strings(value, &|text| redact_body(redactor, text, response_form))
            }
            _ => 0,
        };
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

/// Log attributes and structured bodies are masked recursively before formatting or shortening.
pub(crate) fn redact_log(record: &mut LogRecord, redactor: &Redactor) {
    fn mask(value: &mut AttrValue, redactor: &Redactor) -> usize {
        match value {
            AttrValue::Map(items) => mask_fields(items, redactor),
            AttrValue::Array(items) => items.iter_mut().map(|item| mask(item, redactor)).sum(),
            _ => 0,
        }
    }
    fn mask_fields(fields: &mut Attributes, redactor: &Redactor) -> usize {
        fields
            .iter_mut()
            .map(|(key, value)| {
                if redactor.is_sensitive_key(key) {
                    let count = usize::from(value.as_str() != Some(REDACTED));
                    *value = AttrValue::Str(REDACTED.to_owned());
                    count
                } else if key == URL_FULL {
                    map_strings(value, &|text| redactor.redact_url(text))
                } else {
                    mask(value, redactor)
                }
            })
            .sum()
    }
    let truncated = if record.truncated {
        vec![
            LENS_HTTP_REQUEST_BODY.to_owned(),
            LENS_HTTP_RESPONSE_BODY.to_owned(),
        ]
    } else {
        Vec::new()
    };
    let forms = form_content_types(&record.attributes, (false, false));
    let count = redact_attributes(&mut record.attributes, &truncated, redactor, forms)
        + mask_fields(&mut record.attributes, redactor)
        + mask(&mut record.body, redactor);
    let previous = record
        .attributes
        .get(LENS_REDACTION_COUNT)
        .and_then(AttrValue::as_i64)
        .unwrap_or(0);
    if count > 0 {
        record.attributes.insert(
            LENS_REDACTION_COUNT.to_owned(),
            AttrValue::Int(previous.saturating_add(count as i64)),
        );
    }
    record.truncated |= matches!(
        record
            .attributes
            .get(chepio_lens_conventions::keys::LENS_LOG_TRUNCATED),
        Some(AttrValue::Bool(true))
    );
    record.bound(crate::consts::MAX_LOG_RECORD_BYTES);
}

#[cfg(test)]
mod tests {
    // Core
    use super::*;
    use crate::domain::linker::tests::span;
    use crate::domain::span::{SpanEvent, SpanKind};

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
    fn event_attributes_are_masked_with_the_same_rules() {
        let mut span = span("web", SpanKind::Client, 1, None, &[]);
        span.events.push(SpanEvent {
            name: "retry".into(),
            time_ns: 1,
            truncated_attributes: Vec::new(),
            attributes: [
                (
                    URL_FULL.to_owned(),
                    AttrValue::Str("http://api/login?token=abc".into()),
                ),
                (
                    "http.request.header.authorization".to_owned(),
                    AttrValue::Array(vec![AttrValue::Str("Bearer x".into())]),
                ),
                (
                    LENS_HTTP_REQUEST_BODY.to_owned(),
                    AttrValue::Str(r#"{"password":"demo-password"}"#.into()),
                ),
            ]
            .into(),
        });

        assert_eq!(redact_span(&mut span, &Redactor::default()), 3);

        let event = &span.events[0].attributes;
        assert_eq!(
            event[URL_FULL],
            AttrValue::Str("http://api/login?token=[REDACTED]".into())
        );
        assert_eq!(
            event["http.request.header.authorization"],
            AttrValue::Array(vec![AttrValue::Str("[REDACTED]".into())])
        );
        assert_eq!(
            event[LENS_HTTP_REQUEST_BODY],
            AttrValue::Str(r#"{"password":"[REDACTED]"}"#.into())
        );
        assert_eq!(span.attr_i64(LENS_REDACTION_COUNT), Some(3));
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

    #[test]
    fn event_content_types_override_or_inherit_the_spans_content_types() {
        let body = "user=demo&password=fake-secret";
        for (span_type, event_type, masked) in [
            ("text/plain", Some(FORM_CONTENT_TYPE), true),
            (FORM_CONTENT_TYPE, Some("text/plain"), false),
            (FORM_CONTENT_TYPE, None, true),
        ] {
            let mut span = span("api", SpanKind::Server, 1, None, &[]);
            let mut attributes = Attributes::new();
            for (prefix, body_key) in [
                (HTTP_REQUEST_HEADER_PREFIX, LENS_HTTP_REQUEST_BODY),
                (HTTP_RESPONSE_HEADER_PREFIX, LENS_HTTP_RESPONSE_BODY),
            ] {
                let key = format!("{prefix}content-type");
                span.attributes
                    .insert(key.clone(), AttrValue::Str(span_type.into()));
                if let Some(content_type) = event_type {
                    attributes.insert(
                        key,
                        AttrValue::Array(vec![AttrValue::Str(content_type.into())]),
                    );
                }
                attributes.insert(body_key.into(), AttrValue::Str(body.into()));
            }
            span.events.push(SpanEvent {
                name: "retry".into(),
                time_ns: 1,
                attributes,
                truncated_attributes: Vec::new(),
            });

            assert_eq!(
                redact_span(&mut span, &Redactor::default()),
                if masked { 2 } else { 0 }
            );

            for key in [LENS_HTTP_REQUEST_BODY, LENS_HTTP_RESPONSE_BODY] {
                assert_eq!(
                    span.events[0].attributes[key],
                    AttrValue::Str(
                        if masked {
                            "user=demo&password=[REDACTED]"
                        } else {
                            body
                        }
                        .into()
                    ),
                    "{span_type:?}, {event_type:?}"
                );
            }
        }
    }
}
