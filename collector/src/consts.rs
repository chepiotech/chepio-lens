//! Collector defaults from `docs/architecture/interfaces.md` (Configuration).

// Core
use std::net::{IpAddr, Ipv4Addr, SocketAddr};

/// Default ingest listener (`CHEPIO_LENS_OTLP_ADDR`): the standard OTLP/HTTP port, loopback only (ADR-0003).
pub const DEFAULT_OTLP_ADDR: SocketAddr = SocketAddr::new(IpAddr::V4(Ipv4Addr::LOCALHOST), 4318);

/// Default UI and UI API listener (`CHEPIO_LENS_UI_ADDR`), loopback only (ADR-0003).
pub const DEFAULT_UI_ADDR: SocketAddr = SocketAddr::new(IpAddr::V4(Ipv4Addr::LOCALHOST), 4320);

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
