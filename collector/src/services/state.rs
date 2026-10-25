// Core
use std::sync::Mutex;
use std::sync::atomic::AtomicU64;

// Domain
use crate::domain::graph::{Graph, GraphLimits};
use crate::domain::linker::{Linker, LinkerLimits};
// Ports
use crate::ports::TraceStore;

#[derive(Debug, Clone, Copy)]
pub struct Bounds {
    pub graph: GraphLimits,
    pub linker: LinkerLimits,
}

pub(crate) struct State {
    pub(crate) store: Box<dyn TraceStore>,
    pub(crate) graph: Graph,
    pub(crate) linker: Linker,
}

#[derive(Default)]
pub(crate) struct Counters {
    pub(crate) spans_received: AtomicU64,
    pub(crate) logs_received: AtomicU64,
    pub(crate) logs_rejected: AtomicU64,
    pub(crate) spans_rejected: AtomicU64,
    pub(crate) batches_malformed: AtomicU64,
}

/// Store, graph and linker behind one lock, plus counters.
pub struct Shared {
    pub(crate) state: Mutex<State>,
    pub(crate) counters: Counters,
}

impl Shared {
    pub fn new(store: Box<dyn TraceStore>, bounds: Bounds) -> Self {
        Self {
            state: Mutex::new(State {
                store,
                graph: Graph::new(bounds.graph),
                linker: Linker::new(bounds.linker),
            }),
            counters: Counters::default(),
        }
    }

    /// The state stays consistent even if a thread panicked while holding the lock: every update is applied fully
    /// or not at all, so a poisoned lock is safe to reuse.
    pub(crate) fn lock(&self) -> std::sync::MutexGuard<'_, State> {
        self.state
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
    }
}
