//! Normalized spans, nodes, edges, graph derivation and linking. No I/O and no clock reads: callers pass the time in
//! (`Now`), so linking and windows are deterministic in tests.

pub mod edge;
pub mod event;
pub mod graph;
pub mod linker;
pub mod node;
pub mod request;
pub mod span;
pub mod time;
