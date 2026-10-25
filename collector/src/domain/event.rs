// Domain
use super::edge::EdgeSnapshot;
use super::log::LogEntry;
use super::node::Node;
use super::request::RequestSummary;

/// What changed after an ingest, published to UI clients (`docs/architecture/interfaces.md`, SSE events).
#[derive(Debug, Clone, PartialEq)]
pub enum LensEvent {
    Node(Node),
    Edge(EdgeSnapshot),
    Request(RequestSummary),
    /// A new line in the log, one per stored span.
    Log(LogEntry),
}
