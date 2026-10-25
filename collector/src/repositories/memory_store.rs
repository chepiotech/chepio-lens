//! Bounded in-memory `TraceStore` (ADR-0005): requests in insertion order, bounded by count, by bytes of span data
//! and by spans per request; the log of span lines, ordered by time and bounded by count (I9).

// Core
use std::collections::{BTreeMap, HashMap, HashSet, VecDeque};

// Domain
use crate::domain::log::{LogCursor, LogEntry, LogPage, LogQuery};
use crate::domain::request::{HopRecord, RequestDetail, RequestSummary};
use crate::domain::span::{Span, SpanId, TraceId};
// Ports
use crate::ports::{Inserted, StoreStats, TraceStore};

#[derive(Debug, Clone, Copy)]
pub struct StoreLimits {
    pub max_requests: usize,
    pub max_bytes: usize,
    pub max_spans_per_request: usize,
    pub max_log_entries: usize,
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
    /// One line per stored span, oldest first by time; the oldest is dropped over the bound.
    logs: BTreeMap<LogCursor, LogEntry>,
    log_seq: u64,
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
            logs: BTreeMap::new(),
            log_seq: 0,
        }
    }

    /// Client spans of every stored hop on `edge`.
    fn edge_spans(&self, edge: &str) -> HashSet<(TraceId, SpanId)> {
        self.requests
            .iter()
            .flat_map(|(trace_id, request)| {
                request
                    .hops
                    .iter()
                    .filter(|hop| hop.edge_id == edge)
                    .map(|hop| (*trace_id, hop.client_span_id))
            })
            .collect()
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
        let entry = LogEntry::from_span(&span, self.log_seq);
        self.log_seq += 1;
        request.bytes += size;
        request.spans.push(span);
        self.bytes += size;
        self.evict_over_bounds();
        self.logs.insert(entry.cursor(), entry.clone());
        while self.logs.len() > self.limits.max_log_entries {
            self.logs.pop_first();
        }
        Inserted::Stored(entry)
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

    fn detail(&self, trace_id: &TraceId) -> Option<RequestDetail> {
        let summary = self.summary(trace_id)?;
        let mut spans = self.requests.get(trace_id)?.spans.clone();
        spans.sort_by_key(|span| (span.start_ns, span.span_id));
        Some(RequestDetail { summary, spans })
    }

    fn logs(&self, query: &LogQuery) -> LogPage {
        let edge_spans = query
            .edge
            .as_deref()
            .map(|edge| self.edge_spans(edge))
            .unwrap_or_default();
        let older = match query.before {
            Some(before) => self.logs.range(..before),
            None => self.logs.range(..),
        };
        let mut entries: Vec<LogEntry> = older
            .rev()
            .map(|(_, entry)| entry)
            .filter(|entry| query.matches(entry, &edge_spans))
            .take(query.limit + 1)
            .cloned()
            .collect();
        let next_before = (entries.len() > query.limit).then(|| {
            entries.truncate(query.limit);
            entries.last().map(LogEntry::cursor)
        });
        LogPage {
            entries,
            next_before: next_before.flatten(),
        }
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
            log_entries: self.logs.len(),
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
        max_log_entries: 100,
    };

    fn span_in(trace: u8, id: u8) -> Span {
        let mut span = span("api", SpanKind::Server, id, None, &[]);
        span.trace_id = TraceId([trace; 16]);
        span.span_id = SpanId([id; 8]);
        span
    }

    #[test]
    fn the_log_keeps_the_newest_lines_by_time_within_its_bound() {
        let mut store = MemoryStore::new(StoreLimits {
            max_log_entries: 2,
            ..ROOMY
        });
        // Arrival order differs from time order: the earliest span arrives last.
        for (trace, id) in [(1, 5), (2, 6), (3, 1)] {
            store.insert(span_in(trace, id));
        }

        let page = store.logs(&LogQuery {
            limit: 10,
            ..LogQuery::default()
        });

        let times: Vec<u64> = page.entries.iter().map(|entry| entry.time_ns).collect();
        assert_eq!(
            times,
            [6_000, 5_000],
            "newest first; the earliest by time was dropped"
        );
        assert_eq!(store.stats().log_entries, 2);
        store.clear();
        assert_eq!(store.stats().log_entries, 0);
    }

    #[test]
    fn edge_logs_only_match_the_client_and_its_server_in_the_same_trace() {
        let mut store = MemoryStore::new(ROOMY);
        for trace in [1, 2] {
            for (id, kind, parent) in [
                (1, SpanKind::Client, None),
                (2, SpanKind::Server, Some(1)),
                (3, SpanKind::Internal, Some(1)),
                (4, SpanKind::Client, Some(1)),
            ] {
                let mut span = span_in(trace, id);
                span.kind = kind;
                span.parent_span_id = parent.map(|id| SpanId([id; 8]));
                store.insert(span);
            }
        }
        store.record_hop(
            TraceId([1; 16]),
            HopRecord {
                edge_id: "svc:web->svc:api".into(),
                client_span_id: SpanId([1; 8]),
                start_ns: 1_000,
                duration_ns: 100,
            },
        );

        let page = store.logs(&LogQuery {
            edge: Some("svc:web->svc:api".into()),
            limit: 10,
            ..LogQuery::default()
        });

        let spans: Vec<_> = page
            .entries
            .iter()
            .map(|entry| (entry.trace_id, entry.span_id))
            .collect();
        assert_eq!(
            spans,
            [
                (TraceId([1; 16]), SpanId([2; 8])),
                (TraceId([1; 16]), SpanId([1; 8])),
            ],
            "other traces and non-server children do not belong to this edge"
        );
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
        assert!(matches!(store.insert(span_in(1, 1)), Inserted::Stored(_)));
        assert!(matches!(store.insert(span_in(1, 2)), Inserted::Stored(_)));
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
