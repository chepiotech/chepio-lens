//! Turns sqlx `sqlx::query` tracing events into database client spans (ADR-0008).

// Core
use std::time::{Duration, SystemTime};

use opentelemetry::trace::{Span as _, SpanKind, Tracer};
use opentelemetry::{Context, KeyValue};
use opentelemetry_sdk::trace::SdkTracer;
use tracing::field::{Field, Visit};
use tracing::{Event, Subscriber};
use tracing_subscriber::layer::{Context as LayerContext, Layer};
// Domain
use crate::database::Database;
// Consts
use chepio_lens_conventions::keys::{
    DB_NAMESPACE, DB_OPERATION_NAME, DB_QUERY_TEXT, DB_SYSTEM_NAME, SERVER_ADDRESS, SERVER_PORT,
};

const SQLX_QUERY_TARGET: &str = "sqlx::query";
/// Semantic convention value for a SQL database the SDK was not told about.
const UNKNOWN_SQL_SYSTEM: &str = "other_sql";
const DB_RESPONSE_RETURNED_ROWS: &str = "db.response.returned_rows";

/// No-op when the SDK has no endpoint.
pub struct SqlxEventsLayer {
    inner: Option<(SdkTracer, Option<Database>)>,
}

impl SqlxEventsLayer {
    pub(crate) fn new(inner: Option<(SdkTracer, Option<Database>)>) -> Self {
        Self { inner }
    }
}

#[derive(Default)]
struct QueryFields {
    summary: Option<String>,
    statement: Option<String>,
    elapsed_secs: Option<f64>,
    rows_returned: Option<u64>,
}

impl Visit for QueryFields {
    fn record_str(&mut self, field: &Field, value: &str) {
        match field.name() {
            "summary" => self.summary = Some(value.to_owned()),
            "db.statement" => self.statement = Some(value.to_owned()),
            _ => {}
        }
    }

    fn record_f64(&mut self, field: &Field, value: f64) {
        if field.name() == "elapsed_secs" {
            self.elapsed_secs = Some(value);
        }
    }

    fn record_u64(&mut self, field: &Field, value: u64) {
        if field.name() == "rows_returned" {
            self.rows_returned = Some(value);
        }
    }

    fn record_debug(&mut self, _field: &Field, _value: &dyn std::fmt::Debug) {}
}

impl QueryFields {
    /// The full statement when sqlx cut the summary, else the summary.
    fn text(&self) -> Option<&str> {
        self.statement
            .as_deref()
            .map(str::trim)
            .filter(|statement| !statement.is_empty())
            .or(self.summary.as_deref())
    }
}

impl<S: Subscriber> Layer<S> for SqlxEventsLayer {
    fn on_event(&self, event: &Event<'_>, _ctx: LayerContext<'_, S>) {
        let Some((tracer, database)) = &self.inner else {
            return;
        };
        if event.metadata().target() != SQLX_QUERY_TARGET {
            return;
        }
        let mut fields = QueryFields::default();
        event.record(&mut fields);

        let end = SystemTime::now();
        let elapsed =
            Duration::try_from_secs_f64(fields.elapsed_secs.unwrap_or(0.0)).unwrap_or_default();
        let start = end.checked_sub(elapsed).unwrap_or(end);
        let operation = fields
            .text()
            .and_then(|text| text.split_whitespace().next())
            .map(str::to_ascii_uppercase);

        let mut attributes = vec![KeyValue::new(
            DB_SYSTEM_NAME,
            database
                .as_ref()
                .map_or(UNKNOWN_SQL_SYSTEM.to_owned(), |db| db.system.clone()),
        )];
        if let Some(db) = database {
            if let Some(address) = &db.address {
                attributes.push(KeyValue::new(SERVER_ADDRESS, address.clone()));
            }
            if let Some(port) = db.port {
                attributes.push(KeyValue::new(SERVER_PORT, i64::from(port)));
            }
            if let Some(namespace) = &db.namespace {
                attributes.push(KeyValue::new(DB_NAMESPACE, namespace.clone()));
            }
        }
        if let Some(text) = fields.text() {
            attributes.push(KeyValue::new(DB_QUERY_TEXT, text.to_owned()));
        }
        if let Some(operation) = &operation {
            attributes.push(KeyValue::new(DB_OPERATION_NAME, operation.clone()));
        }
        if let Some(rows) = fields.rows_returned {
            attributes.push(KeyValue::new(
                DB_RESPONSE_RETURNED_ROWS,
                i64::try_from(rows).unwrap_or(i64::MAX),
            ));
        }
        let name = match (
            &operation,
            database.as_ref().and_then(|db| db.namespace.as_ref()),
        ) {
            (Some(operation), Some(namespace)) => format!("{operation} {namespace}"),
            (Some(operation), None) => operation.clone(),
            (None, _) => "query".to_owned(),
        };

        // Parent: the request span the SDK's HTTP layer attached to the handler's future.
        let mut span = tracer
            .span_builder(name)
            .with_kind(SpanKind::Client)
            .with_start_time(start)
            .with_attributes(attributes)
            .start_with_context(tracer, &Context::current());
        span.end_with_timestamp(end);
    }
}
