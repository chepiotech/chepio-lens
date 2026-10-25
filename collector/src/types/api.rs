//! JSON shapes of the UI API and SSE events. `cargo test` exports them as TypeScript to `ui/src/api/generated/`
//! (ts-rs, ADR-0009); CI fails when the committed files differ. Timestamps are nanoseconds since the Unix epoch as
//! decimal strings, because JavaScript numbers lose precision above 2^53 (`docs/architecture/data.md`).

// Core
use serde::Serialize;
use ts_rs::TS;
// Domain
use crate::domain::edge::{EdgeSnapshot, Protocol};
use crate::domain::log::{Layer, LogCursor, LogEntry, LogKind};
use crate::domain::log_record::LogLevel;
use crate::domain::node::{Node, NodeKind};
use crate::domain::request::{RequestDetail, RequestSummary};
use crate::domain::span::{AttrValue, Attributes, Span, SpanKind, Status};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "snake_case")]
#[ts(export)]
pub enum NodeKindView {
    Frontend,
    Service,
    Database,
    External,
}

#[derive(Debug, Clone, PartialEq, Serialize, TS)]
#[ts(export)]
pub struct NodeView {
    pub id: String,
    pub kind: NodeKindView,
    pub label: String,
    pub db_system: Option<String>,
    pub address: Option<String>,
    pub port: Option<u16>,
    pub namespace: Option<String>,
    pub first_seen: String,
    pub last_seen: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "snake_case")]
#[ts(export)]
pub enum ProtocolView {
    Http,
    Db,
}

#[derive(Debug, Clone, PartialEq, Serialize, TS)]
#[ts(export)]
pub struct EdgeView {
    pub id: String,
    pub from: String,
    pub to: String,
    pub protocol: ProtocolView,
    #[ts(type = "number")]
    pub count: u64,
    #[ts(type = "number")]
    pub errors: u64,
    /// Result of the latest completed caller span; cumulative errors remain in `errors`.
    pub last_error: bool,
    /// Exact duration of that caller span, without histogram rounding or animation scaling.
    pub last_duration_ms: f64,
    pub p50_ms: f64,
    pub p95_ms: f64,
    /// Calls per second over the last 60 seconds.
    pub rate_per_s: f64,
    /// Calls per route of the callee, most called first; at most 16 plus `(other routes)`.
    pub routes: Vec<RouteView>,
    pub last_seen: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, TS)]
#[ts(export)]
pub struct RouteView {
    pub route: String,
    #[ts(type = "number")]
    pub count: u64,
    #[ts(type = "number")]
    pub errors: u64,
    pub mean_ms: f64,
    pub max_ms: f64,
}

#[derive(Debug, Clone, PartialEq, Serialize, TS)]
#[ts(export)]
pub struct GraphView {
    pub nodes: Vec<NodeView>,
    pub edges: Vec<EdgeView>,
    pub generated_at: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, TS)]
#[ts(export)]
pub struct RequestView {
    pub trace_id: String,
    pub name: String,
    pub service: String,
    pub method: Option<String>,
    pub route: Option<String>,
    pub status_code: Option<u16>,
    pub start: String,
    pub duration_ms: f64,
    pub services: Vec<String>,
    pub error: bool,
    pub span_count: usize,
    #[ts(type = "number")]
    pub dropped_spans: u64,
    /// A span without a parent has arrived: the request's entry point is known, later batches are unlikely.
    pub has_root: bool,
    /// The edges the request touched, placed on its timeline; the UI animates them.
    pub hops: Vec<HopView>,
}

/// One edge of a request: when the call started relative to the request (call-tree order, never mixing clocks of
/// different processes) and how long the caller saw it take.
#[derive(Debug, Clone, PartialEq, Serialize, TS)]
#[ts(export)]
pub struct HopView {
    pub edge: String,
    pub start_offset_ms: f64,
    pub duration_ms: f64,
}

/// SSE event names on `GET /api/events`: `node` → `NodeView`, `edge` → `EdgeView`, `request` → `RequestView`,
/// `resync` → `{}` (fetch `GET /api/graph` again).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "snake_case")]
#[ts(export)]
pub enum LensEventName {
    Node,
    Edge,
    Request,
    Log,
    Resync,
}

impl LensEventName {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Node => "node",
            Self::Edge => "edge",
            Self::Request => "request",
            Self::Log => "log",
            Self::Resync => "resync",
        }
    }
}

/// `GET /api/stats`: collector counters (`docs/architecture/runtime.md`, self-observability).
#[derive(Debug, Clone, Default, PartialEq, Serialize, TS)]
#[ts(export)]
pub struct StatsView {
    #[ts(type = "number")]
    pub spans_received: u64,
    /// Spans with invalid ids, not stored.
    #[ts(type = "number")]
    pub spans_rejected: u64,
    /// Spans over the per-request bound, not stored.
    #[ts(type = "number")]
    pub spans_dropped: u64,
    #[ts(type = "number")]
    pub batches_malformed: u64,
    /// Export requests refused with 503 because the ingest concurrency bound was reached.
    #[ts(type = "number")]
    pub batches_busy: u64,
    pub requests_stored: usize,
    #[ts(type = "number")]
    pub requests_evicted: u64,
    pub store_bytes: usize,
    pub log_entries: usize,
    pub log_bytes: usize,
    #[ts(type = "number")]
    pub logs_received: u64,
    #[ts(type = "number")]
    pub logs_rejected: u64,
    #[ts(type = "number")]
    pub logs_evicted: u64,
    pub pending_links: usize,
    pub nodes: usize,
    pub edges: usize,
    #[ts(type = "number")]
    pub nodes_dropped: u64,
    #[ts(type = "number")]
    pub edges_dropped: u64,
    pub sse_clients: usize,
}

fn ms(ns: u64) -> f64 {
    ns as f64 / 1_000_000.0
}

/// Signed difference in milliseconds; offsets between processes may be negative (I12).
fn offset_ms(time_ns: u64, from_ns: u64) -> f64 {
    (i128::from(time_ns) - i128::from(from_ns)) as f64 / 1_000_000.0
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "snake_case")]
#[ts(export)]
pub enum LayerView {
    Frontend,
    Backend,
    Database,
}

impl From<Layer> for LayerView {
    fn from(layer: Layer) -> Self {
        match layer {
            Layer::Frontend => Self::Frontend,
            Layer::Backend => Self::Backend,
            Layer::Database => Self::Database,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "snake_case")]
#[ts(export)]
pub enum LogKindView {
    Request,
    Query,
    Call,
    Span,
    Log,
    Action,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "snake_case")]
#[ts(export)]
pub enum LogLevelView {
    Trace,
    Debug,
    Info,
    Warn,
    Error,
    Fatal,
}

impl From<LogLevel> for LogLevelView {
    fn from(level: LogLevel) -> Self {
        match level {
            LogLevel::Trace => Self::Trace,
            LogLevel::Debug => Self::Debug,
            LogLevel::Info => Self::Info,
            LogLevel::Warn => Self::Warn,
            LogLevel::Error => Self::Error,
            LogLevel::Fatal => Self::Fatal,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, TS)]
#[ts(export)]
pub struct LogRecordView {
    pub body: String,
    pub attributes: Vec<AttributeView>,
    pub truncated: bool,
}

/// A log cursor as text: `<time_ns>.<seq>`.
pub fn cursor_text(cursor: LogCursor) -> String {
    format!("{}.{}", cursor.time_ns, cursor.seq)
}

pub fn parse_cursor(text: &str) -> Option<LogCursor> {
    let (time, seq) = text.split_once('.')?;
    Some(LogCursor {
        time_ns: time.parse().ok()?,
        seq: seq.parse().ok()?,
    })
}

/// One line of the logs panel (SSE `log`, `GET /api/logs`).
#[derive(Debug, Clone, PartialEq, Serialize, TS)]
#[ts(export)]
pub struct LogEntryView {
    /// Position in the log; `GET /api/logs?before=<id>` continues with older lines.
    pub id: String,
    pub trace_id: Option<String>,
    pub span_id: Option<String>,
    pub time: String,
    pub duration_ms: Option<f64>,
    pub layer: LayerView,
    pub kind: LogKindView,
    pub service: String,
    /// Node ids the line belongs to: the service, and the database for queries.
    pub nodes: Vec<String>,
    pub text: String,
    pub status_code: Option<u16>,
    pub error: bool,
    pub level: Option<LogLevelView>,
    pub record: Option<LogRecordView>,
}

impl From<&LogEntry> for LogEntryView {
    fn from(entry: &LogEntry) -> Self {
        Self {
            id: cursor_text(entry.cursor()),
            trace_id: entry.trace_id.map(|id| id.to_string()),
            span_id: entry.span_id.map(|id| id.to_string()),
            time: entry.time_ns.to_string(),
            duration_ms: entry.record.is_none().then(|| ms(entry.duration_ns)),
            layer: entry.layer.into(),
            kind: match entry.kind {
                LogKind::Request => LogKindView::Request,
                LogKind::Query => LogKindView::Query,
                LogKind::Call => LogKindView::Call,
                LogKind::Span => LogKindView::Span,
                LogKind::Log => LogKindView::Log,
                LogKind::Action => LogKindView::Action,
            },
            service: entry.service.clone(),
            nodes: entry.nodes.clone(),
            text: entry.text.clone(),
            status_code: entry.status_code,
            error: entry.error,
            level: entry.level.map(LogLevelView::from),
            record: entry.record.as_ref().map(|record| LogRecordView {
                body: record.body.text(),
                attributes: attribute_views(&record.attributes),
                truncated: record.truncated,
            }),
        }
    }
}

/// `GET /api/logs`: newest first.
#[derive(Debug, Clone, PartialEq, Serialize, TS)]
#[ts(export)]
pub struct LogPageView {
    pub entries: Vec<LogEntryView>,
    /// Pass as `before` for the next, older page; `null` at the start of the log.
    pub next_before: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "snake_case")]
#[ts(export)]
pub enum AttrKindView {
    String,
    Bool,
    Int,
    Double,
    Array,
    Map,
}

/// An attribute as text: one value, or one per array item (e.g. repeated headers).
#[derive(Debug, Clone, PartialEq, Serialize, TS)]
#[ts(export)]
pub struct AttributeView {
    pub key: String,
    pub kind: AttrKindView,
    pub values: Vec<String>,
}

fn scalar_text(value: &AttrValue) -> String {
    match value {
        AttrValue::Str(text) => text.clone(),
        AttrValue::Bool(flag) => flag.to_string(),
        AttrValue::Int(number) => number.to_string(),
        AttrValue::Double(number) => number.to_string(),
        AttrValue::Array(items) => items.iter().map(scalar_text).collect::<Vec<_>>().join(", "),
        AttrValue::Map(_) => value.text(),
    }
}

fn attribute_views(attributes: &Attributes) -> Vec<AttributeView> {
    attributes
        .iter()
        .map(|(key, value)| {
            let (kind, values) = match value {
                AttrValue::Str(_) => (AttrKindView::String, vec![scalar_text(value)]),
                AttrValue::Bool(_) => (AttrKindView::Bool, vec![scalar_text(value)]),
                AttrValue::Int(_) => (AttrKindView::Int, vec![scalar_text(value)]),
                AttrValue::Double(_) => (AttrKindView::Double, vec![scalar_text(value)]),
                AttrValue::Map(_) => (AttrKindView::Map, vec![value.text()]),
                AttrValue::Array(items) => {
                    (AttrKindView::Array, items.iter().map(scalar_text).collect())
                }
            };
            AttributeView {
                key: key.clone(),
                kind,
                values,
            }
        })
        .collect()
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "snake_case")]
#[ts(export)]
pub enum SpanKindView {
    Server,
    Client,
    Internal,
    Producer,
    Consumer,
    Unspecified,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "snake_case")]
#[ts(export)]
pub enum SpanStatusView {
    Unset,
    Ok,
    Error,
}

#[derive(Debug, Clone, PartialEq, Serialize, TS)]
#[ts(export)]
pub struct SpanEventView {
    pub name: String,
    /// From the span's start; negative when the clocks disagree.
    pub offset_ms: f64,
    pub attributes: Vec<AttributeView>,
    /// Event attribute keys whose values the collector cut.
    pub truncated_attributes: Vec<String>,
}

/// One span of a request, with everything the inspector shows.
#[derive(Debug, Clone, PartialEq, Serialize, TS)]
#[ts(export)]
pub struct SpanView {
    pub span_id: String,
    pub parent_span_id: Option<String>,
    pub service: String,
    pub layer: LayerView,
    pub kind: SpanKindView,
    pub name: String,
    pub start: String,
    /// From the request's earliest span, as received: spans of different processes use different clocks (I12).
    pub start_offset_ms: f64,
    pub duration_ms: f64,
    pub status: SpanStatusView,
    pub status_message: Option<String>,
    pub attributes: Vec<AttributeView>,
    pub events: Vec<SpanEventView>,
    /// Attribute keys whose values the collector cut, and `events` when events were dropped.
    pub truncated_attributes: Vec<String>,
}

impl SpanView {
    fn new(span: &Span, request_start_ns: u64) -> Self {
        let (status, status_message) = match &span.status {
            Status::Unset => (SpanStatusView::Unset, None),
            Status::Ok => (SpanStatusView::Ok, None),
            Status::Error { message } => (
                SpanStatusView::Error,
                (!message.is_empty()).then(|| message.clone()),
            ),
        };
        Self {
            span_id: span.span_id.to_string(),
            parent_span_id: span.parent_span_id.map(|id| id.to_string()),
            service: span.service.name.clone(),
            layer: Layer::of(span).into(),
            kind: match span.kind {
                SpanKind::Server => SpanKindView::Server,
                SpanKind::Client => SpanKindView::Client,
                SpanKind::Internal => SpanKindView::Internal,
                SpanKind::Producer => SpanKindView::Producer,
                SpanKind::Consumer => SpanKindView::Consumer,
                SpanKind::Unspecified => SpanKindView::Unspecified,
            },
            name: span.name.clone(),
            start: span.start_ns.to_string(),
            start_offset_ms: offset_ms(span.start_ns, request_start_ns),
            duration_ms: ms(span.duration_ns()),
            status,
            status_message,
            attributes: attribute_views(&span.attributes),
            events: span
                .events
                .iter()
                .map(|event| SpanEventView {
                    name: event.name.clone(),
                    offset_ms: offset_ms(event.time_ns, span.start_ns),
                    attributes: attribute_views(&event.attributes),
                    truncated_attributes: event.truncated_attributes.clone(),
                })
                .collect(),
            truncated_attributes: span.truncated_attributes.clone(),
        }
    }
}

/// `GET /api/requests/{trace_id}`.
#[derive(Debug, Clone, PartialEq, Serialize, TS)]
#[ts(export)]
pub struct RequestDetailView {
    pub request: RequestView,
    pub spans: Vec<SpanView>,
}

impl From<&RequestDetail> for RequestDetailView {
    fn from(detail: &RequestDetail) -> Self {
        Self {
            request: RequestView::from(&detail.summary),
            spans: detail
                .spans
                .iter()
                .map(|span| SpanView::new(span, detail.summary.start_ns))
                .collect(),
        }
    }
}

impl From<&Node> for NodeView {
    fn from(node: &Node) -> Self {
        let kind = match node.kind {
            NodeKind::Frontend => NodeKindView::Frontend,
            NodeKind::Service => NodeKindView::Service,
            NodeKind::Database => NodeKindView::Database,
            NodeKind::External => NodeKindView::External,
        };
        let db = node.db.as_ref();
        let external = node.external.as_ref();
        Self {
            id: node.id.clone(),
            kind,
            label: node.label.clone(),
            db_system: db.map(|db| db.system.clone()),
            address: db
                .and_then(|db| db.address.clone())
                .or_else(|| external.and_then(|ext| ext.address.clone())),
            port: db
                .and_then(|db| db.port)
                .or_else(|| external.and_then(|ext| ext.port)),
            namespace: db.and_then(|db| db.namespace.clone()),
            first_seen: node.first_seen_ns.to_string(),
            last_seen: node.last_seen_ns.to_string(),
        }
    }
}

impl From<&EdgeSnapshot> for EdgeView {
    fn from(edge: &EdgeSnapshot) -> Self {
        Self {
            id: edge.key.id(),
            from: edge.key.from.clone(),
            to: edge.key.to.clone(),
            protocol: match edge.key.protocol {
                Protocol::Http => ProtocolView::Http,
                Protocol::Db => ProtocolView::Db,
            },
            count: edge.count,
            errors: edge.errors,
            last_error: edge.last_error,
            last_duration_ms: ms(edge.last_duration_ns),
            p50_ms: ms(edge.p50_ns),
            p95_ms: ms(edge.p95_ns),
            rate_per_s: edge.rate_per_second,
            routes: edge
                .routes
                .iter()
                .map(|route| RouteView {
                    route: route.route.clone(),
                    count: route.count,
                    errors: route.errors,
                    mean_ms: ms(route.mean_ns),
                    max_ms: ms(route.max_ns),
                })
                .collect(),
            last_seen: edge.last_seen_ns.to_string(),
        }
    }
}

impl From<&RequestSummary> for RequestView {
    fn from(request: &RequestSummary) -> Self {
        Self {
            trace_id: request.trace_id.to_string(),
            name: request.name.clone(),
            service: request.service.clone(),
            method: request.method.clone(),
            route: request.route.clone(),
            status_code: request.status_code,
            start: request.start_ns.to_string(),
            duration_ms: ms(request.duration_ns),
            services: request.services.clone(),
            error: request.error,
            span_count: request.span_count,
            dropped_spans: request.dropped_spans,
            has_root: request.has_root,
            hops: request
                .hops
                .iter()
                .map(|hop| HopView {
                    edge: hop.edge.clone(),
                    start_offset_ms: ms(hop.start_offset_ns),
                    duration_ms: ms(hop.duration_ns),
                })
                .collect(),
        }
    }
}
