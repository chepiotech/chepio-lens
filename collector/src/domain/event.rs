// Domain
use super::activity::ActivityUpdate;
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
    /// A new or changed activity (ADR-0016).
    Activity(ActivityUpdate),
}
