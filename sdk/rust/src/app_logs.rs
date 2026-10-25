//! Bounded, redacted bridge from the app's tracing events to OTLP logs.

// Core
use opentelemetry::Context;
use opentelemetry::logs::{AnyValue, LogRecord, Logger, Severity};
use opentelemetry_sdk::logs::{SdkLogRecord, SdkLogger};
use std::fmt::{self, Write};
use std::sync::Arc;
use std::time::SystemTime;
use tracing::Event;
use tracing::field::{Field, Visit};
// Domain
use crate::capture::CaptureConfig;
// Consts
use chepio_lens_conventions::keys::{LENS_LOG_TRUNCATED, LENS_REDACTION_COUNT};
use chepio_lens_conventions::redaction::REDACTED;

const FIELD_BYTES: usize = 2_048;
const RECORD_BYTES: usize = 12_288;
const FIELD_COUNT: usize = 64;

pub(crate) struct AppLogs {
    logger: SdkLogger,
    capture: Arc<CaptureConfig>,
}

impl AppLogs {
    pub(crate) fn new(logger: SdkLogger, capture: Arc<CaptureConfig>) -> Self {
        Self { logger, capture }
    }

    pub(crate) fn record(&self, event: &Event<'_>) {
        let target = event.metadata().target();
        // Reqwest's blocking client runs HTTP work on another thread, outside the exporter's suppressed context.
        // Exclude transport diagnostics from this export layer only; the app's other tracing layers still see them.
        if Context::is_current_telemetry_suppressed()
            || target.starts_with("opentelemetry")
            || ["hyper", "hyper_util", "h2", "reqwest"].iter().any(|name| {
                target == *name
                    || target
                        .strip_prefix(name)
                        .is_some_and(|rest| rest.starts_with("::"))
            })
        {
            return;
        }
        let mut record = self.logger.create_log_record();
        record.set_timestamp(SystemTime::now());
        record.set_target(event.metadata().target());
        record.set_severity_text(event.metadata().level().as_str());
        record.set_severity_number(match *event.metadata().level() {
            tracing::Level::TRACE => Severity::Trace,
            tracing::Level::DEBUG => Severity::Debug,
            tracing::Level::INFO => Severity::Info,
            tracing::Level::WARN => Severity::Warn,
            tracing::Level::ERROR => Severity::Error,
        });
        record.add_attribute("log.target", event.metadata().target());
        let mut visitor = Fields {
            record: &mut record,
            capture: &self.capture,
            bytes: 0,
            count: 0,
            masked: 0,
            truncated: false,
        };
        event.record(&mut visitor);
        let (masked, truncated) = (visitor.masked, visitor.truncated);
        if masked > 0 {
            record.add_attribute(LENS_REDACTION_COUNT, masked as i64);
        }
        if truncated {
            record.add_attribute(LENS_LOG_TRUNCATED, true);
        }
        // SdkLogger attaches the current OTel trace/span context and enqueues without waiting for export.
        self.logger.emit(record);
    }
}

struct Fields<'a> {
    record: &'a mut SdkLogRecord,
    capture: &'a CaptureConfig,
    bytes: usize,
    count: usize,
    masked: usize,
    truncated: bool,
}

impl Fields<'_> {
    fn sensitive(&mut self, field: &Field) -> bool {
        if self.capture.redactor.is_sensitive_key(field.name()) {
            self.masked += 1;
            self.add(field, AnyValue::from(REDACTED), REDACTED.len());
            true
        } else {
            false
        }
    }

    fn add(&mut self, field: &Field, value: AnyValue, bytes: usize) {
        if self.count >= FIELD_COUNT || self.bytes + field.name().len() + bytes > RECORD_BYTES {
            self.truncated = true;
            return;
        }
        self.count += 1;
        self.bytes += field.name().len() + bytes;
        if field.name() == "message" {
            self.record.set_body(value);
        } else {
            self.record.add_attribute(field.name(), value);
        }
    }

    fn text(&mut self, field: &Field, value: &str) {
        if self.sensitive(field) {
            return;
        }
        if value.len() > FIELD_BYTES {
            // Do not export a cut JSON prefix whose keys could no longer be masked.
            self.truncated = true;
            self.add(field, AnyValue::from("[TRUNCATED]"), 11);
            return;
        }
        let redacted = self.capture.redactor.redact_json(value);
        let text = if let Some(redacted) = redacted {
            self.masked += redacted.count;
            redacted.text
        } else {
            value.to_owned()
        };
        let bytes = text.len();
        self.add(field, AnyValue::from(text), bytes);
    }
}

impl Visit for Fields<'_> {
    fn record_str(&mut self, field: &Field, value: &str) {
        self.text(field, value);
    }
    fn record_bool(&mut self, field: &Field, value: bool) {
        if !self.sensitive(field) {
            self.add(field, AnyValue::from(value), 8);
        }
    }
    fn record_i64(&mut self, field: &Field, value: i64) {
        if !self.sensitive(field) {
            self.add(field, AnyValue::from(value), 8);
        }
    }
    fn record_u64(&mut self, field: &Field, value: u64) {
        if !self.sensitive(field) {
            match i64::try_from(value) {
                Ok(value) => self.add(field, AnyValue::from(value), 8),
                Err(_) => self.text(field, &value.to_string()),
            }
        }
    }
    fn record_f64(&mut self, field: &Field, value: f64) {
        if !self.sensitive(field) {
            self.add(field, AnyValue::from(value), 8);
        }
    }
    fn record_debug(&mut self, field: &Field, value: &dyn fmt::Debug) {
        if self.sensitive(field) {
            return;
        }
        let mut text = LimitedText(String::new());
        if write!(&mut text, "{value:?}").is_err() {
            self.truncated = true;
            self.add(field, AnyValue::from("[TRUNCATED]"), 11);
        } else {
            self.text(field, &text.0);
        }
    }
}

struct LimitedText(String);
impl Write for LimitedText {
    fn write_str(&mut self, text: &str) -> fmt::Result {
        if self.0.len() + text.len() > FIELD_BYTES {
            return Err(fmt::Error);
        }
        self.0.push_str(text);
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    // Core
    use super::*;
    use opentelemetry::logs::LoggerProvider;
    use opentelemetry::trace::{TraceContextExt, Tracer, TracerProvider};
    use opentelemetry_sdk::logs::{InMemoryLogExporter, SdkLoggerProvider};
    use opentelemetry_sdk::trace::{InMemorySpanExporter, SdkTracerProvider};
    use tracing_subscriber::{filter::LevelFilter, prelude::*};
    // Domain
    use crate::sqlx_events::SqlxEventsLayer;
    use chepio_lens_conventions::redaction::Redactor;

    #[test]
    fn tracing_events_keep_context_and_levels_mask_fields_and_skip_internal_events() {
        let exporter = InMemoryLogExporter::default();
        let logs = SdkLoggerProvider::builder()
            .with_simple_exporter(exporter.clone())
            .build();
        let traces = SdkTracerProvider::builder()
            .with_simple_exporter(InMemorySpanExporter::default())
            .build();
        let tracer = traces.tracer("test");
        let capture = Arc::new(CaptureConfig {
            bodies: true,
            body_limit: 1024,
            redactor: Redactor::new(&["tenant"]),
        });
        let layer = SqlxEventsLayer::new(
            Some((tracer.clone(), None)),
            Some(AppLogs::new(logs.logger("test"), capture)),
        );
        let subscriber = tracing_subscriber::registry().with(layer.with_filter(LevelFilter::INFO));
        let span = tracer.start("request");
        let cx = Context::current().with_span(span);
        let expected = cx.span().span_context().clone();
        tracing::subscriber::with_default(subscriber, || {
            let _guard = cx.attach();
            struct MustNotFormat;
            impl fmt::Debug for MustNotFormat {
                fn fmt(&self, _: &mut fmt::Formatter<'_>) -> fmt::Result {
                    panic!("sensitive Debug must not run")
                }
            }
            tracing::info!(password = ?MustNotFormat, token = 42, tenant = true, nested = r#"{"password":"fake-nested"}"#, "saved");
            tracing::debug!("filtered out");
            tracing::info!(target: "sqlx::query", summary = "SELECT 1", elapsed_secs = 0.001);
            tracing::warn!(target: "opentelemetry_sdk", "internal diagnostic");
            let _suppressed = Context::enter_telemetry_suppressed_scope();
            tracing::error!("exporter internals");
        });
        let emitted = exporter.get_emitted_logs().unwrap();
        assert_eq!(emitted.len(), 1);
        let record = &emitted[0].record;
        assert_eq!(record.severity_number(), Some(Severity::Info));
        assert_eq!(
            record.trace_context().unwrap().trace_id,
            expected.trace_id()
        );
        assert_eq!(record.trace_context().unwrap().span_id, expected.span_id());
        for key in ["password", "token", "tenant"] {
            assert_eq!(
                &record
                    .attributes_iter()
                    .find(|(k, _)| k.as_str() == key)
                    .unwrap()
                    .1,
                &AnyValue::from(REDACTED)
            );
        }
        let text = format!("{record:?}");
        assert!(!text.contains("fake-nested"));
        assert!(text.contains("[REDACTED]"));
    }

    #[test]
    fn oversized_debug_and_strings_are_bounded_and_marked() {
        let exporter = InMemoryLogExporter::default();
        let logs = SdkLoggerProvider::builder()
            .with_simple_exporter(exporter.clone())
            .build();
        let traces = SdkTracerProvider::builder().build();
        let capture = Arc::new(CaptureConfig {
            bodies: true,
            body_limit: 1024,
            redactor: Redactor::default(),
        });
        let layer = SqlxEventsLayer::new(
            Some((traces.tracer("test"), None)),
            Some(AppLogs::new(logs.logger("test"), capture)),
        );
        tracing::subscriber::with_default(tracing_subscriber::registry().with(layer), || {
            tracing::warn!(text = "é".repeat(50_000), debug = ?vec![0; 50_000], "large event");
        });
        let emitted = exporter.get_emitted_logs().unwrap();
        let record = &emitted[0].record;
        assert!(format!("{record:?}").len() < 2_048);
        assert_eq!(
            &record
                .attributes_iter()
                .find(|(key, _)| key.as_str() == LENS_LOG_TRUNCATED)
                .unwrap()
                .1,
            &AnyValue::Boolean(true)
        );
        assert!(record.trace_context().is_none());
    }
}
