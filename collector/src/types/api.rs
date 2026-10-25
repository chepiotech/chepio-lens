//! JSON shapes of the UI API and SSE events. `cargo test` exports them as TypeScript to `ui/src/api/generated/`
//! (ts-rs, ADR-0009); CI fails when the committed files differ. Timestamps are nanoseconds since the Unix epoch as
//! decimal strings, because JavaScript numbers lose precision above 2^53 (`docs/architecture/data.md`).

// Core
use serde::Serialize;
use ts_rs::TS;
// Domain
use crate::domain::edge::{EdgeSnapshot, Protocol};
use crate::domain::node::{Node, NodeKind};
use crate::domain::request::RequestSummary;

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
    pub p50_ms: f64,
    pub p95_ms: f64,
    /// Calls per second over the last 60 seconds.
    pub rate_per_s: f64,
    pub last_seen: String,
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
    Resync,
}

impl LensEventName {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Node => "node",
            Self::Edge => "edge",
            Self::Request => "request",
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
            p50_ms: ms(edge.p50_ns),
            p95_ms: ms(edge.p95_ns),
            rate_per_s: edge.rate_per_second,
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
