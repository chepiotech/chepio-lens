// Core
use chepio_lens_conventions::keys::LENS_NODE_METADATA;
use chepio_lens_conventions::keys::{LENS_NODE_KIND, SERVICE_NAME, TELEMETRY_SDK_LANGUAGE};
use chepio_lens_conventions::node_metadata::NodeMetadata;
use opentelemetry_proto::tonic::collector::logs::v1::{
    ExportLogsPartialSuccess, ExportLogsServiceRequest, ExportLogsServiceResponse,
};
use opentelemetry_proto::tonic::common::v1::any_value;
use prost::Message;
use std::sync::Arc;
// Domain
use crate::domain::log_record::{LogLevel, LogRecord};
use crate::domain::span::{AttrValue, Service, SpanId, TraceId};
// Ports
use crate::ports::DecodedLogs;
// Adapters
use super::otlp::ProtoCodec;
// Types
use crate::types::OtlpEncoding;

impl ProtoCodec {
    pub(crate) fn logs(&self, encoding: OtlpEncoding, body: &[u8]) -> Result<DecodedLogs, String> {
        let request: ExportLogsServiceRequest = match encoding {
            OtlpEncoding::Protobuf => ExportLogsServiceRequest::decode(body)
                .map_err(|_| "malformed OTLP log protobuf".to_owned())?,
            OtlpEncoding::Json => {
                serde_json::from_slice(body).map_err(|_| "malformed OTLP log JSON".to_owned())?
            }
        };
        let mut batch = DecodedLogs::default();
        for resource_logs in request.resource_logs {
            let resource = resource_logs
                .resource
                .map(|r| r.attributes)
                .unwrap_or_default();
            let resource_str = |key: &str| {
                resource.iter().find(|kv| kv.key == key).and_then(|kv| {
                    match kv.value.as_ref()?.value.as_ref()? {
                        any_value::Value::StringValue(text) => Some(text.as_str()),
                        _ => None,
                    }
                })
            };
            let mut service = Service::from_resource(
                resource_str(SERVICE_NAME),
                resource_str(TELEMETRY_SDK_LANGUAGE),
                resource_str(LENS_NODE_KIND),
            );
            service.metadata = resource_str(LENS_NODE_METADATA)
                .and_then(NodeMetadata::from_json)
                .map(Arc::new);
            let service_cut = service.name.len() > 256;
            if service_cut {
                let mut end = 256;
                while !service.name.is_char_boundary(end) {
                    end -= 1;
                }
                service.name.truncate(end);
                service.name.shrink_to_fit();
            }
            for scope in resource_logs.scope_logs {
                for record in scope.log_records {
                    let trace_id = TraceId::from_slice(&record.trace_id);
                    let span_id = SpanId::from_slice(&record.span_id);
                    let absent = |id: &[u8], length| {
                        id.is_empty() || (id.len() == length && id.iter().all(|b| *b == 0))
                    };
                    if (!absent(&record.trace_id, 16) && trace_id.is_none())
                        || (!absent(&record.span_id, 8) && span_id.is_none())
                        || (span_id.is_some() && trace_id.is_none())
                        || !(0..=24).contains(&record.severity_number)
                    {
                        batch.rejected += 1;
                        continue;
                    }
                    let (attributes, truncated) = self.normalize(record.attributes);
                    batch.records.push(LogRecord {
                        trace_id,
                        span_id,
                        service: service.clone(),
                        time_ns: if record.time_unix_nano == 0 {
                            record.observed_time_unix_nano
                        } else {
                            record.time_unix_nano
                        },
                        level: LogLevel::from_otlp(record.severity_number, &record.severity_text),
                        body: record
                            .body
                            .and_then(|value| self.convert(value))
                            .unwrap_or_else(|| AttrValue::Str(String::new())),
                        attributes,
                        truncated: service_cut
                            || !truncated.is_empty()
                            || record.dropped_attributes_count > 0,
                    });
                }
            }
        }
        Ok(batch)
    }
}

pub(crate) fn response(encoding: OtlpEncoding, rejected: u64) -> Vec<u8> {
    let response = ExportLogsServiceResponse {
        partial_success: (rejected > 0).then(|| ExportLogsPartialSuccess {
            rejected_log_records: i64::try_from(rejected).unwrap_or(i64::MAX),
            error_message: "log records with invalid context or severity".to_owned(),
        }),
    };
    match encoding {
        OtlpEncoding::Protobuf => response.encode_to_vec(),
        OtlpEncoding::Json if rejected == 0 => b"{}".to_vec(),
        OtlpEncoding::Json => serde_json::to_vec(&response).unwrap_or_else(|_| b"{}".to_vec()),
    }
}
