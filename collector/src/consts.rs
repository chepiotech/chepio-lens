//! Collector defaults from `docs/architecture/interfaces.md` (Configuration) and `docs/architecture/runtime.md`
//! (Bounds, Timeouts). Change them there and here together.

// Core
use std::net::{IpAddr, Ipv4Addr, SocketAddr};
use std::time::Duration;

/// Default ingest listener (`CHEPIO_LENS_OTLP_ADDR`): the standard OTLP/HTTP port, loopback only (ADR-0003).
pub const DEFAULT_OTLP_ADDR: SocketAddr = SocketAddr::new(IpAddr::V4(Ipv4Addr::LOCALHOST), 4318);

/// Default UI and UI API listener (`CHEPIO_LENS_UI_ADDR`), loopback only (ADR-0003).
pub const DEFAULT_UI_ADDR: SocketAddr = SocketAddr::new(IpAddr::V4(Ipv4Addr::LOCALHOST), 4320);

/// Default browser origins allowed to post spans (`CHEPIO_LENS_CORS_ORIGINS`): the demo web, under both loopback names
/// a developer may type.
pub const DEFAULT_CORS_ORIGINS: &[&str] = &["http://localhost:5173", "http://127.0.0.1:5173"];
/// How long browsers may cache a CORS preflight answer.
pub const CORS_MAX_AGE: Duration = Duration::from_secs(600);

pub const MAX_OTLP_BODY_BYTES: usize = 4 * 1024 * 1024;
pub const MAX_CONCURRENT_INGEST: usize = 64;
pub const MAX_STORED_REQUESTS: usize = 10_000;
pub const MAX_STORED_BYTES: usize = 256 * 1024 * 1024;
pub const MAX_SPANS_PER_REQUEST: usize = 1_000;
pub const MAX_ATTRIBUTE_VALUE_BYTES: usize = 256 * 1024;
/// Events kept per span; later ones are dropped and counted in `truncated_attributes` as `events`.
pub const MAX_EVENTS_PER_SPAN: usize = 32;
pub const MAX_PENDING_CLIENTS: usize = 10_000;
/// Server spans waiting for their client parent; same bound as the pending clients.
pub const MAX_ORPHAN_SERVERS: usize = 10_000;
/// Lines in the logs panel's log (one per stored span); the oldest by time is dropped first.
pub const MAX_LOG_ENTRIES: usize = 50_000;
/// `GET /api/logs` page size: default and maximum.
pub const LOG_PAGE_DEFAULT: usize = 100;
pub const LOG_PAGE_MAX: usize = 500;
pub const MAX_NODES: usize = 1_000;
pub const MAX_EDGES: usize = 5_000;
pub const MAX_SSE_CLIENTS: usize = 16;
pub const SSE_BUFFER_EVENTS: usize = 4_096;

pub const LINK_WINDOW: Duration = Duration::from_secs(10);
pub const BODY_READ_TIMEOUT: Duration = Duration::from_secs(10);
pub const SHUTDOWN_GRACE: Duration = Duration::from_secs(5);
/// How often pending client spans are checked against the link window.
pub const EXPIRY_TICK: Duration = Duration::from_secs(1);

#[cfg(test)]
mod tests {
    // Core
    use super::*;

    #[test]
    fn default_listeners_are_loopback() {
        assert!(DEFAULT_OTLP_ADDR.ip().is_loopback());
        assert!(DEFAULT_UI_ADDR.ip().is_loopback());
    }
}
