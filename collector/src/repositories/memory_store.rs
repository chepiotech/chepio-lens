//! Bounded in-memory `TraceStore` (ADR-0005): requests in insertion order, bounded by count, by bytes of span data
//! and by spans per request (I9).

// Core
use std::collections::{HashMap, VecDeque};

// Domain
use crate::domain::request::{HopRecord, RequestSummary};
use crate::domain::span::{Span, TraceId};
// Ports
use crate::ports::{Inserted, StoreStats, TraceStore};

#[derive(Debug, Clone, Copy)]
pub struct StoreLimits {
    pub max_requests: usize,
    pub max_bytes: usize,
    pub max_spans_per_request: usize,
}

#[derive(Default)]
struct StoredRequest {
    spans: Vec<Span>,
    hops: Vec<HopRecord>,
    bytes: usize,
    dropped_spans: u64,
}

pub struct MemoryStore {
    limits: StoreLimits,
    requests: HashMap<TraceId, StoredRequest>,
    /// Oldest first, by the arrival of a request's first span.
    order: VecDeque<TraceId>,
    bytes: usize,
    evicted_requests: u64,
    dropped_spans: u64,
}

impl MemoryStore {
    pub fn new(limits: StoreLimits) -> Self {
        Self {
            limits,
            requests: HashMap::new(),
            order: VecDeque::new(),
            bytes: 0,
            evicted_requests: 0,
            dropped_spans: 0,
        }
    }

    fn evict_over_bounds(&mut self) {
        while self.requests.len() > self.limits.max_requests || self.bytes > self.limits.max_bytes {
            let Some(oldest) = self.order.pop_front() else {
                break;
            };
            if let Some(request) = self.requests.remove(&oldest) {
                self.bytes -= request.bytes;
                self.evicted_requests += 1;
            }
        }
    }
}

impl TraceStore for MemoryStore {
    fn insert(&mut self, span: Span) -> Inserted {
        let trace_id = span.trace_id;
        let request = self.requests.entry(trace_id).or_insert_with(|| {
            self.order.push_back(trace_id);
            StoredRequest::default()
        });
        if request.spans.len() >= self.limits.max_spans_per_request {
            request.dropped_spans += 1;
            self.dropped_spans += 1;
            return Inserted::Dropped;
        }
        let size = span.approx_size();
        request.bytes += size;
        request.spans.push(span);
        self.bytes += size;
        self.evict_over_bounds();
        Inserted::Stored
    }

    fn record_hop(&mut self, trace_id: TraceId, hop: HopRecord) {
        if let Some(request) = self.requests.get_mut(&trace_id) {
            let size = hop.edge_id.len() + 24;
            request.bytes += size;
            self.bytes += size;
            request.hops.push(hop);
            self.evict_over_bounds();
        }
    }

    fn summary(&self, trace_id: &TraceId) -> Option<RequestSummary> {
        let request = self.requests.get(trace_id)?;
        (!request.spans.is_empty()).then(|| {
            RequestSummary::from_spans(
                *trace_id,
                &request.spans,
                &request.hops,
                request.dropped_spans,
            )
        })
    }

    fn clear(&mut self) {
        *self = Self::new(self.limits);
    }

    fn stats(&self) -> StoreStats {
        StoreStats {
            requests: self.requests.len(),
            bytes: self.bytes,
            evicted_requests: self.evicted_requests,
            dropped_spans: self.dropped_spans,
        }
    }
}

#[cfg(test)]
mod tests {
    // Core
    use super::*;
    use crate::domain::linker::tests::span;
    use crate::domain::span::{SpanId, SpanKind};

    const ROOMY: StoreLimits = StoreLimits {
        max_requests: 100,
        max_bytes: usize::MAX,
        max_spans_per_request: 100,
    };

    fn span_in(trace: u8, id: u8) -> Span {
        let mut span = span("api", SpanKind::Server, id, None, &[]);
        span.trace_id = TraceId([trace; 16]);
        span.span_id = SpanId([id; 8]);
        span
    }

    #[test]
    fn request_count_bound_evicts_the_oldest_request() {
        let mut store = MemoryStore::new(StoreLimits {
            max_requests: 2,
            ..ROOMY
        });
        for trace in 1..=3 {
            store.insert(span_in(trace, 1));
        }
        assert!(store.summary(&TraceId([1; 16])).is_none());
        assert!(store.summary(&TraceId([3; 16])).is_some());
        assert_eq!(store.stats().requests, 2);
        assert_eq!(store.stats().evicted_requests, 1);
    }

    #[test]
    fn byte_bound_evicts_the_oldest_request() {
        let size = span_in(1, 1).approx_size();
        let mut store = MemoryStore::new(StoreLimits {
            max_bytes: size * 2,
            ..ROOMY
        });
        store.insert(span_in(1, 1));
        store.insert(span_in(1, 2));
        store.insert(span_in(2, 1));
        assert!(
            store.summary(&TraceId([1; 16])).is_none(),
            "the oldest request made room"
        );
        assert_eq!(store.stats().bytes, size);
        assert_eq!(store.stats().evicted_requests, 1);
    }

    #[test]
    fn spans_per_request_bound_drops_and_counts_further_spans() {
        let mut store = MemoryStore::new(StoreLimits {
            max_spans_per_request: 2,
            ..ROOMY
        });
        assert_eq!(store.insert(span_in(1, 1)), Inserted::Stored);
        assert_eq!(store.insert(span_in(1, 2)), Inserted::Stored);
        assert_eq!(store.insert(span_in(1, 3)), Inserted::Dropped);
        let summary = store.summary(&TraceId([1; 16])).unwrap();
        assert_eq!((summary.span_count, summary.dropped_spans), (2, 1));
        assert_eq!(store.stats().dropped_spans, 1);
    }

    #[test]
    fn hops_of_evicted_requests_are_ignored_and_clear_empties_the_store() {
        let mut store = MemoryStore::new(ROOMY);
        let hop = |client: u8| HopRecord {
            edge_id: "svc:a->svc:b".into(),
            client_span_id: SpanId([client; 8]),
            start_ns: 5,
            duration_ns: 1,
        };
        store.record_hop(TraceId([9; 16]), hop(1));
        assert_eq!(store.stats().bytes, 0);
        store.insert(span_in(1, 1));
        store.record_hop(TraceId([1; 16]), hop(1));
        let hops = store.summary(&TraceId([1; 16])).unwrap().hops;
        assert_eq!(
            hops.iter().map(|hop| hop.edge.as_str()).collect::<Vec<_>>(),
            ["svc:a->svc:b"]
        );
        store.clear();
        assert_eq!(store.stats(), StoreStats::default());
    }
}
