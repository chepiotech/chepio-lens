//! OTLP/HTTP decoding (protobuf and JSON) into normalized domain spans. Legacy semantic convention names are mapped
//! to stable ones here, once (I8); attribute values over the collector's limit are cut and marked.

// Core
use chepio_lens_conventions::keys::{
    HTTP_RESPONSE_STATUS_CODE, LENS_NODE_KIND, SERVER_PORT, SERVICE_NAME, TELEMETRY_SDK_LANGUAGE,
    URL_PATH, URL_QUERY,
};
use chepio_lens_conventions::legacy;
use opentelemetry_proto::tonic::collector::trace::v1::{
    ExportTracePartialSuccess, ExportTraceServiceRequest, ExportTraceServiceResponse,
};
use opentelemetry_proto::tonic::common::v1::{AnyValue, KeyValue, any_value};
use opentelemetry_proto::tonic::trace::v1::span::SpanKind as ProtoSpanKind;
use opentelemetry_proto::tonic::trace::v1::status::StatusCode;
use prost::Message;
// Domain
use crate::domain::span::{
    AttrValue, Attributes, Service, Span, SpanEvent, SpanId, SpanKind, Status, TraceId,
};
// Ports
use crate::ports::{DecodedBatch, DecodedLogs, OtlpCodec};
// Types
use crate::types::OtlpEncoding;
// Consts
use crate::consts::MAX_EVENTS_PER_SPAN;

pub struct ProtoCodec {
    max_attribute_bytes: usize,
}

impl ProtoCodec {
    pub fn new(max_attribute_bytes: usize) -> Self {
        Self {
            max_attribute_bytes,
        }
    }

    fn to_spans(&self, request: ExportTraceServiceRequest) -> DecodedBatch {
        let mut batch = DecodedBatch::default();
        for resource_spans in request.resource_spans {
            let resource = resource_spans
                .resource
                .map(|resource| resource.attributes)
                .unwrap_or_default();
            let resource_str = |key: &str| {
                resource.iter().find(|kv| kv.key == key).and_then(|kv| {
                    match kv.value.as_ref()?.value.as_ref()? {
                        any_value::Value::StringValue(value) => Some(value.as_str()),
                        _ => None,
                    }
                })
            };
            let service = Service::from_resource(
                resource_str(SERVICE_NAME),
                resource_str(TELEMETRY_SDK_LANGUAGE),
                resource_str(LENS_NODE_KIND),
            );
            for scope_spans in resource_spans.scope_spans {
                for span in scope_spans.spans {
                    let (Some(trace_id), Some(span_id)) = (
                        TraceId::from_slice(&span.trace_id),
                        SpanId::from_slice(&span.span_id),
                    ) else {
                        batch.rejected += 1;
                        continue;
                    };
                    let (attributes, mut truncated_attributes) = self.normalize(span.attributes);
                    if span.events.len() > MAX_EVENTS_PER_SPAN {
                        truncated_attributes.push("events".to_owned());
                    }
                    let events = span
                        .events
                        .into_iter()
                        .take(MAX_EVENTS_PER_SPAN)
                        .map(|event| {
                            let (attributes, truncated_attributes) =
                                self.normalize(event.attributes);
                            SpanEvent {
                                name: event.name,
                                time_ns: event.time_unix_nano,
                                attributes,
                                truncated_attributes,
                            }
                        })
                        .collect();
                    batch.spans.push(Span {
                        trace_id,
                        span_id,
                        parent_span_id: SpanId::from_slice(&span.parent_span_id),
                        service: service.clone(),
                        kind: span_kind(span.kind),
                        name: span.name,
                        start_ns: span.start_time_unix_nano,
                        end_ns: span.end_time_unix_nano,
                        status: status(span.status),
                        attributes,
                        truncated_attributes,
                        events,
                    });
                }
            }
        }
        batch
    }

    /// Stable names win over legacy ones; legacy `http.target` fills `url.path` and `url.query` when they are absent.
    pub(crate) fn normalize(&self, attributes: Vec<KeyValue>) -> (Attributes, Vec<String>) {
        let mut stable = Attributes::new();
        let mut renamed = Vec::new();
        let mut target = None;
        let mut truncated = Vec::new();
        for KeyValue { key, value, .. } in attributes {
            let Some(mut value) = value.and_then(|value| self.convert(value)) else {
                continue;
            };
            if self.truncate(&mut value) {
                truncated.push(key.clone());
            }
            if key == legacy::HTTP_TARGET {
                target = Some(value);
            } else if let Some(stable_key) = legacy::stable_name(&key) {
                renamed.push((stable_key.to_owned(), value));
            } else {
                stable.insert(key, value);
            }
        }
        for (key, value) in renamed {
            stable.entry(key).or_insert(value);
        }
        if let Some(AttrValue::Str(target)) = target {
            let (path, query) = legacy::split_target(&target);
            stable
                .entry(URL_PATH.to_owned())
                .or_insert_with(|| AttrValue::Str(path.to_owned()));
            if let Some(query) = query {
                stable
                    .entry(URL_QUERY.to_owned())
                    .or_insert_with(|| AttrValue::Str(query.to_owned()));
            }
        }
        // Some exporters send these numbers as strings; domain code reads them as integers.
        for key in [SERVER_PORT, HTTP_RESPONSE_STATUS_CODE] {
            if let Some(AttrValue::Str(text)) = stable.get(key)
                && let Ok(number) = text.parse::<i64>()
            {
                stable.insert(key.to_owned(), AttrValue::Int(number));
            }
        }
        (stable, truncated)
    }

    pub(crate) fn convert(&self, value: AnyValue) -> Option<AttrValue> {
        Some(match value.value? {
            any_value::Value::StringValue(value) => AttrValue::Str(value),
            any_value::Value::BoolValue(value) => AttrValue::Bool(value),
            any_value::Value::IntValue(value) => AttrValue::Int(value),
            any_value::Value::DoubleValue(value) => AttrValue::Double(value),
            any_value::Value::ArrayValue(array) => AttrValue::Array(
                array
                    .values
                    .into_iter()
                    .filter_map(|item| self.convert(item))
                    .collect(),
            ),
            any_value::Value::KvlistValue(list) => AttrValue::Map(
                list.values
                    .into_iter()
                    .filter_map(|kv| Some((kv.key, self.convert(kv.value?)?)))
                    .collect(),
            ),
            any_value::Value::BytesValue(bytes) => {
                AttrValue::Str(bytes.iter().map(|byte| format!("{byte:02x}")).collect())
            }
            _ => return None,
        })
    }

    /// Cuts strings over the limit at a character boundary; returns whether anything was cut.
    fn truncate(&self, value: &mut AttrValue) -> bool {
        match value {
            AttrValue::Str(text) if text.len() > self.max_attribute_bytes => {
                let mut end = self.max_attribute_bytes;
                while !text.is_char_boundary(end) {
                    end -= 1;
                }
                text.truncate(end);
                text.shrink_to_fit();
                true
            }
            AttrValue::Map(items) => {
                let mut cut = false;
                for item in items.values_mut() {
                    cut |= self.truncate(item);
                }
                cut
            }
            // Every item must be cut, so no short-circuiting `any`.
            AttrValue::Array(items) => {
                let mut cut = false;
                for item in items {
                    cut |= self.truncate(item);
                }
                cut
            }
            _ => false,
        }
    }
}

fn span_kind(kind: i32) -> SpanKind {
    match ProtoSpanKind::try_from(kind) {
        Ok(ProtoSpanKind::Internal) => SpanKind::Internal,
        Ok(ProtoSpanKind::Server) => SpanKind::Server,
        Ok(ProtoSpanKind::Client) => SpanKind::Client,
        Ok(ProtoSpanKind::Producer) => SpanKind::Producer,
        Ok(ProtoSpanKind::Consumer) => SpanKind::Consumer,
        _ => SpanKind::Unspecified,
    }
}

fn status(status: Option<opentelemetry_proto::tonic::trace::v1::Status>) -> Status {
    match status {
        Some(status) if status.code == StatusCode::Error as i32 => Status::Error {
            message: status.message,
        },
        Some(status) if status.code == StatusCode::Ok as i32 => Status::Ok,
        _ => Status::Unset,
    }
}

impl OtlpCodec for ProtoCodec {
    fn decode_logs(&self, encoding: OtlpEncoding, body: &[u8]) -> Result<DecodedLogs, String> {
        self.logs(encoding, body)
    }

    fn encode_logs_response(&self, encoding: OtlpEncoding, rejected: u64) -> Vec<u8> {
        super::otlp_logs::response(encoding, rejected)
    }

    fn decode(&self, encoding: OtlpEncoding, body: &[u8]) -> Result<DecodedBatch, String> {
        let request = match encoding {
            OtlpEncoding::Protobuf => {
                ExportTraceServiceRequest::decode(body).map_err(|error| error.to_string())?
            }
            OtlpEncoding::Json => {
                serde_json::from_slice(body).map_err(|error| error.to_string())?
            }
        };
        Ok(self.to_spans(request))
    }

    fn encode_response(
        &self,
        encoding: OtlpEncoding,
        rejected_spans: u64,
        message: &str,
    ) -> Vec<u8> {
        let response = ExportTraceServiceResponse {
            partial_success: (rejected_spans > 0).then(|| ExportTracePartialSuccess {
                rejected_spans: i64::try_from(rejected_spans).unwrap_or(i64::MAX),
                error_message: message.to_owned(),
            }),
        };
        match encoding {
            OtlpEncoding::Protobuf => response.encode_to_vec(),
            // Without partial success the message is empty; `{}` rather than `{"partialSuccess":null}`.
            OtlpEncoding::Json if response.partial_success.is_none() => b"{}".to_vec(),
            OtlpEncoding::Json => serde_json::to_vec(&response).unwrap_or_else(|_| b"{}".to_vec()),
        }
    }
}

#[cfg(test)]
mod tests {
    // Core
    use chepio_lens_conventions::keys::{DB_QUERY_TEXT, HTTP_REQUEST_METHOD};

    use super::*;

    const JSON: &str = include_str!("../../tests/fixtures/legacy_names.json");

    #[test]
    fn json_with_legacy_names_is_normalized_once() {
        let batch = ProtoCodec::new(1024)
            .decode(OtlpEncoding::Json, JSON.as_bytes())
            .unwrap();
        assert_eq!(batch.rejected, 1, "the span with a zero trace id");
        let span = &batch.spans[0];
        assert_eq!(span.service.name, "legacy-api");
        assert_eq!(span.kind, SpanKind::Server);
        assert_eq!(
            span.attr_str(HTTP_REQUEST_METHOD),
            Some("POST"),
            "http.method wins only when absent"
        );
        assert_eq!(span.attr_i64(HTTP_RESPONSE_STATUS_CODE), Some(201));
        assert_eq!(span.attr_str(URL_PATH), Some("/api/notes"));
        assert_eq!(span.attr_str(URL_QUERY), Some("draft=true"));
        assert!(!span.attributes.contains_key("http.method"));
        assert!(!span.attributes.contains_key("http.target"));
        let db = &batch.spans[1];
        assert_eq!(db.attr_str(DB_QUERY_TEXT), Some("SELECT id FROM notes"));
        assert_eq!(
            db.attr_i64(SERVER_PORT),
            Some(5432),
            "string port coerced to an integer"
        );
        assert_eq!(db.parent_span_id, Some(span.span_id));
        assert!(matches!(db.status, Status::Error { .. }));
    }

    #[test]
    fn span_events_are_kept_up_to_the_bound_with_normalized_attributes() {
        let mut request: ExportTraceServiceRequest = serde_json::from_str(JSON).unwrap();
        let span = &mut request.resource_spans[0].scope_spans[0].spans[0];
        span.events = (0..MAX_EVENTS_PER_SPAN + 3)
            .map(|i| opentelemetry_proto::tonic::trace::v1::span::Event {
                time_unix_nano: 1_000 + i as u64,
                name: format!("event {i}"),
                attributes: vec![KeyValue {
                    key: "http.method".into(),
                    value: Some(AnyValue {
                        value: Some(any_value::Value::StringValue("GET".into())),
                    }),
                    ..KeyValue::default()
                }],
                ..Default::default()
            })
            .collect();

        let batch = ProtoCodec::new(1024)
            .decode(OtlpEncoding::Protobuf, &request.encode_to_vec())
            .unwrap();

        let span = &batch.spans[0];
        assert_eq!(span.events.len(), MAX_EVENTS_PER_SPAN);
        assert_eq!(span.events[0].name, "event 0");
        assert_eq!(span.events[0].time_ns, 1_000);
        assert_eq!(
            span.events[0].attributes.get(HTTP_REQUEST_METHOD),
            Some(&AttrValue::Str("GET".into()))
        );
        assert!(span.truncated_attributes.contains(&"events".to_owned()));
    }

    #[test]
    fn protobuf_decodes_the_same_spans_as_json() {
        let codec = ProtoCodec::new(1024);
        let request: ExportTraceServiceRequest = serde_json::from_str(JSON).unwrap();
        let from_protobuf = codec
            .decode(OtlpEncoding::Protobuf, &request.encode_to_vec())
            .unwrap();
        let from_json = codec.decode(OtlpEncoding::Json, JSON.as_bytes()).unwrap();
        assert_eq!(from_protobuf.spans, from_json.spans);
    }

    #[test]
    fn long_values_are_cut_at_a_character_boundary_and_marked() {
        let codec = ProtoCodec::new(5);
        let (attributes, truncated) = codec.normalize(vec![KeyValue {
            key: "lens.http.request.body".into(),
            value: Some(AnyValue {
                value: Some(any_value::Value::StringValue("ééé".into())),
            }),
            ..KeyValue::default()
        }]);
        assert_eq!(
            attributes["lens.http.request.body"],
            AttrValue::Str("éé".into())
        );
        assert_eq!(truncated, ["lens.http.request.body"]);
    }

    #[test]
    fn malformed_bodies_are_errors() {
        let codec = ProtoCodec::new(1024);
        assert!(codec.decode(OtlpEncoding::Json, b"{not json").is_err());
        assert!(
            codec
                .decode(OtlpEncoding::Protobuf, &[0xff, 0xff, 0xff])
                .is_err()
        );
    }

    #[test]
    fn partial_success_is_reported_only_when_spans_were_rejected() {
        let codec = ProtoCodec::new(1024);
        assert_eq!(codec.encode_response(OtlpEncoding::Json, 0, ""), b"{}");
        let json =
            String::from_utf8(codec.encode_response(OtlpEncoding::Json, 2, "invalid ids")).unwrap();
        assert!(json.contains("\"rejectedSpans\":2"), "{json}");
        let decoded = ExportTraceServiceResponse::decode(
            codec
                .encode_response(OtlpEncoding::Protobuf, 2, "x")
                .as_slice(),
        )
        .unwrap();
        assert_eq!(decoded.partial_success.unwrap().rejected_spans, 2);
    }
}
