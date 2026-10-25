// Core
use std::sync::Arc;
use std::sync::atomic::Ordering;

// Domain
use crate::domain::edge::EdgeSnapshot;
use crate::domain::log::{LogPage, LogQuery};
use crate::domain::node::Node;
use crate::domain::request::RequestDetail;
use crate::domain::span::TraceId;
use crate::domain::time::Now;
// Ports
use crate::ports::{EventFeed, EventStream};
// Services
use super::state::Shared;
// Types
use crate::types::api::StatsView;

pub struct GraphSnapshot {
    pub nodes: Vec<Node>,
    pub edges: Vec<EdgeSnapshot>,
    pub generated_at_ns: u64,
}

pub struct Query {
    shared: Arc<Shared>,
    feed: Arc<dyn EventFeed>,
}

impl Query {
    pub fn new(shared: Arc<Shared>, feed: Arc<dyn EventFeed>) -> Self {
        Self { shared, feed }
    }

    pub fn graph(&self, now: Now) -> GraphSnapshot {
        let (nodes, edges) = self.shared.lock().graph.snapshot(now.mono_ms);
        GraphSnapshot {
            nodes,
            edges,
            generated_at_ns: now.unix_ns,
        }
    }

    pub fn logs(&self, query: &LogQuery) -> LogPage {
        self.shared.lock().store.logs(query)
    }

    pub fn request(&self, trace_id: &TraceId) -> Option<RequestDetail> {
        self.shared.lock().store.detail(trace_id)
    }

    pub fn subscribe(&self) -> EventStream {
        self.feed.subscribe()
    }

    /// Counters owned by the services; HTTP-level ones (busy batches, SSE clients) are added by the handlers.
    pub fn stats(&self) -> StatsView {
        let counters = &self.shared.counters;
        let state = self.shared.lock();
        let store = state.store.stats();
        let graph = state.graph.counts();
        StatsView {
            spans_received: counters.spans_received.load(Ordering::Relaxed),
            spans_rejected: counters.spans_rejected.load(Ordering::Relaxed),
            spans_dropped: store.dropped_spans,
            batches_malformed: counters.batches_malformed.load(Ordering::Relaxed),
            requests_stored: store.requests,
            requests_evicted: store.evicted_requests,
            store_bytes: store.bytes,
            log_entries: store.log_entries,
            pending_links: state.linker.pending_count(),
            nodes: graph.nodes,
            edges: graph.edges,
            nodes_dropped: graph.dropped_nodes,
            edges_dropped: graph.dropped_edges,
            ..StatsView::default()
        }
    }
}
