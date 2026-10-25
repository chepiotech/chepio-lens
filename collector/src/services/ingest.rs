// Core
use std::collections::BTreeSet;
use std::sync::Arc;
use std::sync::atomic::Ordering;

use chepio_lens_conventions::redaction::Redactor;
// Domain
use crate::domain::event::LensEvent;
use crate::domain::graph::Changes;
use crate::domain::linker::Link;
use crate::domain::log::LogEntry;
use crate::domain::request::HopRecord;
use crate::domain::span::{Span, TraceId};
use crate::domain::time::Now;
// Ports
use crate::ports::{EventPublisher, Inserted, OtlpCodec};
// Services
use super::redaction::{redact_log, redact_span};
use super::state::{Shared, State};
// Types
use crate::types::OtlpEncoding;

pub enum IngestReply {
    /// OTLP response body in the request's encoding, with partial success when spans were rejected.
    Accepted {
        body: Vec<u8>,
    },
    Malformed {
        message: String,
    },
}

pub struct Ingest {
    shared: Arc<Shared>,
    codec: Arc<dyn OtlpCodec>,
    publisher: Arc<dyn EventPublisher>,
    redactor: Redactor,
}

impl Ingest {
    pub fn new(
        shared: Arc<Shared>,
        codec: Arc<dyn OtlpCodec>,
        publisher: Arc<dyn EventPublisher>,
        redactor: Redactor,
    ) -> Self {
        Self {
            shared,
            codec,
            publisher,
            redactor,
        }
    }

    /// Decodes and redacts before taking the lock; publishes after releasing it.
    pub fn handle(&self, encoding: OtlpEncoding, body: &[u8], now: Now) -> IngestReply {
        let counters = &self.shared.counters;
        let batch = match self.codec.decode(encoding, body) {
            Ok(batch) => batch,
            Err(message) => {
                counters.batches_malformed.fetch_add(1, Ordering::Relaxed);
                return IngestReply::Malformed { message };
            }
        };
        let received = batch.spans.len() as u64 + batch.rejected;
        counters
            .spans_received
            .fetch_add(received, Ordering::Relaxed);
        counters
            .spans_rejected
            .fetch_add(batch.rejected, Ordering::Relaxed);

        let mut spans = batch.spans;
        for span in &mut spans {
            redact_span(span, &self.redactor);
        }
        let (events, dropped) = self.apply(spans, now);
        self.publish(&events);

        let rejected = batch.rejected + dropped;
        let message = match (batch.rejected, dropped) {
            (0, 0) => "",
            (_, 0) => "spans with invalid trace or span ids",
            (0, _) => "spans over the per-request limit",
            _ => "spans with invalid ids or over the per-request limit",
        };
        IngestReply::Accepted {
            body: self.codec.encode_response(encoding, rejected, message),
        }
    }

    /// App logs share the bounded log and service nodes; they never increment call counters.
    pub fn handle_logs(&self, encoding: OtlpEncoding, body: &[u8], now: Now) -> IngestReply {
        let counters = &self.shared.counters;
        let mut batch = match self.codec.decode_logs(encoding, body) {
            Ok(batch) => batch,
            Err(message) => {
                counters.batches_malformed.fetch_add(1, Ordering::Relaxed);
                return IngestReply::Malformed { message };
            }
        };
        counters.logs_received.fetch_add(
            batch.records.len() as u64 + batch.rejected,
            Ordering::Relaxed,
        );
        counters
            .logs_rejected
            .fetch_add(batch.rejected, Ordering::Relaxed);
        for record in &mut batch.records {
            if record.time_ns == 0 {
                record.time_ns = now.unix_ns;
            }
            redact_log(record, &self.redactor);
        }
        let updates = {
            let mut state = self.shared.lock();
            let mut changes = Changes::default();
            let mut logs = Vec::new();
            for record in batch.records {
                state
                    .graph
                    .observe_service(&record.service, now, &mut changes);
                logs.push(state.store.insert_log(record));
            }
            events(&state, &changes, &BTreeSet::new(), logs, now)
        };
        self.publish(&updates);
        IngestReply::Accepted {
            body: self.codec.encode_logs_response(encoding, batch.rejected),
        }
    }

    /// Counts client spans whose link window has passed on their external nodes.
    pub fn tick(&self, now: Now) {
        let events = {
            let mut state = self.shared.lock();
            let mut changes = Changes::default();
            let mut touched = BTreeSet::new();
            let links = state.linker.expire(now.mono_ms);
            for link in &links {
                record(&mut state, link, now, &mut changes, &mut touched);
            }
            // Expiry adds hops to stored spans; no new log lines.
            events(&state, &changes, &touched, Vec::new(), now)
        };
        self.publish(&events);
    }

    /// `POST /api/reset`: clears requests, graph and pending links.
    pub fn reset(&self) {
        let mut state = self.shared.lock();
        state.store.clear();
        state.graph.clear();
        state.linker.clear();
    }

    /// Returns the events to publish and how many spans the store dropped.
    fn apply(&self, spans: Vec<Span>, now: Now) -> (Vec<LensEvent>, u64) {
        let mut state = self.shared.lock();
        let mut changes = Changes::default();
        let mut touched = BTreeSet::new();
        let mut logs = Vec::new();
        let mut dropped = 0;
        for span in spans {
            state
                .graph
                .observe_service(&span.service, now, &mut changes);
            let links = state.linker.on_span(&span, now.mono_ms);
            let trace_id = span.trace_id;
            match state.store.insert(span) {
                Inserted::Stored(entry) => {
                    touched.insert(trace_id);
                    logs.push(entry);
                }
                Inserted::Dropped => dropped += 1,
            }
            for link in &links {
                record(&mut state, link, now, &mut changes, &mut touched);
            }
        }
        for link in &state.linker.expire(now.mono_ms) {
            record(&mut state, link, now, &mut changes, &mut touched);
        }
        (events(&state, &changes, &touched, logs, now), dropped)
    }

    fn publish(&self, events: &[LensEvent]) {
        for event in events {
            self.publisher.publish(event);
        }
    }
}

fn record(
    state: &mut State,
    link: &Link,
    now: Now,
    changes: &mut Changes,
    touched: &mut BTreeSet<TraceId>,
) {
    if let Some(key) = state.graph.record(link, now, changes) {
        state.store.record_hop(
            link.trace_id,
            HopRecord {
                edge_id: key.id(),
                client_span_id: link.client_span_id,
                start_ns: link.start_ns,
                duration_ns: link.duration_ns,
            },
        );
        touched.insert(link.trace_id);
    }
}

/// New nodes first, then changed edges, then the touched requests and the new log lines, so a client always knows the
/// nodes an edge uses.
fn events(
    state: &State,
    changes: &Changes,
    touched: &BTreeSet<TraceId>,
    logs: Vec<LogEntry>,
    now: Now,
) -> Vec<LensEvent> {
    let nodes = changes
        .nodes
        .iter()
        .filter_map(|id| state.graph.node(id).cloned().map(LensEvent::Node));
    let edges = changes.edges.iter().filter_map(|key| {
        state
            .graph
            .edge_snapshot(key, now.mono_ms)
            .map(LensEvent::Edge)
    });
    let requests = touched
        .iter()
        .filter_map(|trace_id| state.store.summary(trace_id).map(LensEvent::Request));
    nodes
        .chain(edges)
        .chain(requests)
        .chain(logs.into_iter().map(LensEvent::Log))
        .collect()
}
