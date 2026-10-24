//! Interfaces the services need; repositories and adapters implement them.

// Core
use std::pin::Pin;

use futures_util::Stream;
// Domain
use crate::domain::event::LensEvent;
use crate::domain::request::RequestSummary;
use crate::domain::span::{Span, TraceId};
// Types
use crate::types::{FeedItem, OtlpEncoding};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Inserted {
    Stored,
    /// The request already holds the most spans allowed; the span is counted and dropped.
    Dropped,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct StoreStats {
    pub requests: usize,
    pub bytes: usize,
    pub evicted_requests: u64,
    pub dropped_spans: u64,
}

/// Recent requests and their spans (ADR-0005). Bounded; the oldest request is evicted first.
pub trait TraceStore: Send {
    fn insert(&mut self, span: Span) -> Inserted;
    /// Remembers that the request touched an edge; ignored when the request was already evicted.
    fn record_edge(&mut self, trace_id: TraceId, start_ns: u64, edge_id: String);
    fn summary(&self, trace_id: &TraceId) -> Option<RequestSummary>;
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
