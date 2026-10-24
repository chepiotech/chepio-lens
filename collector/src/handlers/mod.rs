//! HTTP surface: the OTLP ingest listener and the UI listener (`docs/architecture/interfaces.md`, sections 1 and 3).

mod assets;
mod ingest;
mod ui;

// Core
use std::collections::HashMap;
use std::sync::atomic::AtomicU64;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use axum::Router;
use axum::middleware::map_response;
use axum::routing::{get, post};
use tokio::sync::Semaphore;
// Services
use crate::services::clock::Clock;
use crate::services::ingest::Ingest;
use crate::services::query::Query;

#[derive(Debug, Clone, Copy)]
pub struct HttpLimits {
    pub max_body_bytes: usize,
    pub body_read_timeout: Duration,
    pub max_concurrent_ingest: usize,
    pub max_sse_clients: usize,
}

pub struct AppState {
    pub ingest: Ingest,
    pub query: Query,
    pub clock: Clock,
    limits: HttpLimits,
    ingest_permits: Arc<Semaphore>,
    sse_permits: Arc<Semaphore>,
    batches_busy: AtomicU64,
    warnings: Warnings,
}

impl AppState {
    pub fn new(ingest: Ingest, query: Query, clock: Clock, limits: HttpLimits) -> Arc<Self> {
        Arc::new(Self {
            ingest,
            query,
            clock,
            limits,
            ingest_permits: Arc::new(Semaphore::new(limits.max_concurrent_ingest)),
            sse_permits: Arc::new(Semaphore::new(limits.max_sse_clients)),
            batches_busy: AtomicU64::new(0),
            warnings: Warnings::default(),
        })
    }
}

/// `POST /v1/traces`.
pub fn otlp_router(state: Arc<AppState>) -> Router {
    Router::new()
        .route("/v1/traces", post(ingest::traces))
        .with_state(state)
}

/// UI API, SSE, health and the embedded UI; every response carries the UI's security headers.
pub fn ui_router(state: Arc<AppState>) -> Router {
    Router::new()
        .route("/api/graph", get(ui::graph))
        .route("/api/events", get(ui::events))
        .route("/api/reset", post(ui::reset))
        .route("/api/stats", get(ui::stats))
        .route("/healthz", get(ui::healthz))
        .fallback(assets::asset)
        .layer(map_response(assets::security_headers))
        .with_state(state)
}

/// Logs a warning at most once per minute per reason, so bad input cannot flood the log.
#[derive(Default)]
struct Warnings {
    last: Mutex<HashMap<&'static str, Instant>>,
}

impl Warnings {
    const INTERVAL: Duration = Duration::from_secs(60);

    fn should_log(&self, reason: &'static str) -> bool {
        let mut last = self
            .last
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let now = Instant::now();
        match last.get(reason) {
            Some(at) if now.duration_since(*at) < Self::INTERVAL => false,
            _ => {
                last.insert(reason, now);
                true
            }
        }
    }
}
