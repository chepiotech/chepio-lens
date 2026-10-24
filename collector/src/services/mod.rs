//! Use cases: `Ingest` (decode → redact → store → derive graph → publish) and `Query` (graph, events, stats). Both
//! share one state behind a `std::sync::Mutex`, held only for in-memory updates and never across `.await`
//! (`docs/architecture/runtime.md`).

pub mod clock;
pub mod ingest;
pub mod query;
mod redaction;
mod state;

pub use state::{Bounds, Shared};
