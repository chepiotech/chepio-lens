//! Interfaces the services need; repositories and adapters implement them.

// Core
use std::pin::Pin;

use futures_util::Stream;
// Domain
use crate::domain::event::LensEvent;
use crate::domain::log::{LogEntry, LogPage, LogQuery};
use crate::domain::request::{HopRecord, RequestDetail, RequestSummary};
use crate::domain::span::{Span, TraceId};
// Types
use crate::types::{FeedItem, OtlpEncoding};

#[derive(Debug, Clone, PartialEq)]
pub enum Inserted {
    /// Stored, with the span's line in the log.
    Stored(LogEntry),
    /// The request already holds the most spans allowed; the span is counted and dropped.
    Dropped,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct StoreStats {
    pub requests: usize,
    pub bytes: usize,
    pub evicted_requests: u64,
    pub dropped_spans: u64,
    pub log_entries: usize,
}

/// Recent requests and their spans (ADR-0005). Bounded; the oldest request is evicted first.
pub trait TraceStore: Send {
    fn insert(&mut self, span: Span) -> Inserted;
    /// Remembers that the request touched an edge; ignored when the request was already evicted.
    fn record_hop(&mut self, trace_id: TraceId, hop: HopRecord);
    fn summary(&self, trace_id: &TraceId) -> Option<RequestSummary>;
    fn detail(&self, trace_id: &TraceId) -> Option<RequestDetail>;
    /// Log entries matching `query`, newest first. The log has its own count bound, independent of requests.
    fn logs(&self, query: &LogQuery) -> LogPage;
    fn clear(&mut self);
    fn stats(&self) -> StoreStats;
}

/// A decoded OTLP export request: the spans that passed validation, and how many did not.
#[derive(Debug, Default)]
pub struct DecodedBatch {
    pub spans: Vec<Span>,
    pub rejected: u64,
}

/// OTLP wire format: decodes export requests into normalized spans (I8) and encodes responses.
pub trait OtlpCodec: Send + Sync {
    fn decode(&self, encoding: OtlpEncoding, body: &[u8]) -> Result<DecodedBatch, String>;
    fn encode_response(
        &self,
        encoding: OtlpEncoding,
        rejected_spans: u64,
        message: &str,
    ) -> Vec<u8>;
}

pub trait EventPublisher: Send + Sync {
    fn publish(&self, event: &LensEvent);
}

pub type EventStream = Pin<Box<dyn Stream<Item = FeedItem> + Send>>;

pub trait EventFeed: Send + Sync {
    fn subscribe(&self) -> EventStream;
}
