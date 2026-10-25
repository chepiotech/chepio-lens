//! Composition root: configuration from the environment and wiring of repositories, adapters, services and handlers.

// Core
use std::net::SocketAddr;
use std::sync::Arc;

use chepio_lens_conventions::redaction::Redactor;
// Domain
use crate::domain::graph::GraphLimits;
use crate::domain::linker::LinkerLimits;
// Services
use crate::services::clock::Clock;
use crate::services::ingest::Ingest;
use crate::services::query::Query;
use crate::services::{Bounds, Shared};
// Repositories
use crate::repositories::memory_store::{MemoryStore, StoreLimits};
// Adapters
use crate::adapters::otlp::ProtoCodec;
use crate::adapters::sse::SseHub;
// Handlers
use crate::handlers::{AppState, HttpLimits};
// Consts
use crate::consts::{
    BODY_READ_TIMEOUT, DEFAULT_CORS_ORIGINS, DEFAULT_OTLP_ADDR, DEFAULT_UI_ADDR, LINK_WINDOW,
    MAX_ATTRIBUTE_VALUE_BYTES, MAX_CONCURRENT_INGEST, MAX_EDGES, MAX_LOG_BYTES, MAX_LOG_ENTRIES,
    MAX_NODES, MAX_ORPHAN_SERVERS, MAX_OTLP_BODY_BYTES, MAX_PENDING_CLIENTS, MAX_SPANS_PER_REQUEST,
    MAX_SSE_CLIENTS, MAX_STORED_BYTES, MAX_STORED_REQUESTS, SSE_BUFFER_EVENTS,
};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Config {
    pub otlp_addr: SocketAddr,
    pub ui_addr: SocketAddr,
    /// `CHEPIO_LENS_REDACT_KEYS`: added to the redaction defaults, never replacing them.
    pub redact_keys: Vec<String>,
    /// `CHEPIO_LENS_CORS_ORIGINS`: browser origins allowed to post spans, normalized as browsers send them.
    pub cors_origins: Vec<String>,
}

impl Config {
    /// Reads `CHEPIO_LENS_OTLP_ADDR`, `CHEPIO_LENS_UI_ADDR`, `CHEPIO_LENS_REDACT_KEYS` and
    /// `CHEPIO_LENS_CORS_ORIGINS` through `var`.
    pub fn from_env(var: impl Fn(&str) -> Option<String>) -> Result<Self, String> {
        let addr = |name: &str, default: SocketAddr| match var(name) {
            Some(value) => value.parse().map_err(|error| {
                format!("{name}={value:?} is not an address like 127.0.0.1:4318: {error}")
            }),
            None => Ok(default),
        };
        Ok(Self {
            otlp_addr: addr("CHEPIO_LENS_OTLP_ADDR", DEFAULT_OTLP_ADDR)?,
            ui_addr: addr("CHEPIO_LENS_UI_ADDR", DEFAULT_UI_ADDR)?,
            redact_keys: var("CHEPIO_LENS_REDACT_KEYS")
                .map(|keys| {
                    keys.split(',')
                        .map(str::trim)
                        .filter(|key| !key.is_empty())
                        .map(str::to_owned)
                        .collect()
                })
                .unwrap_or_default(),
            cors_origins: match var("CHEPIO_LENS_CORS_ORIGINS") {
                Some(list) => list
                    .split(',')
                    .map(str::trim)
                    .filter(|origin| !origin.is_empty())
                    .map(cors_origin)
                    .collect::<Result<_, _>>()?,
                None => DEFAULT_CORS_ORIGINS
                    .iter()
                    .map(|origin| (*origin).to_owned())
                    .collect(),
            },
        })
    }
}

/// Browsers send `Origin` as `scheme://host[:port]` in lowercase, so a configured origin is normalized to that form;
/// anything else (a path, a wildcard, another scheme) is refused rather than silently never matching.
fn cors_origin(value: &str) -> Result<String, String> {
    let origin = value.trim_end_matches('/').to_ascii_lowercase();
    let host = origin
        .strip_prefix("http://")
        .or_else(|| origin.strip_prefix("https://"));
    match host {
        Some(host)
            if !host.is_empty()
                && host
                    .chars()
                    .all(|c| c.is_ascii_graphic() && !"/?#*@".contains(c)) =>
        {
            Ok(origin)
        }
        _ => Err(format!(
            "CHEPIO_LENS_CORS_ORIGINS: {value:?} is not an origin like http://localhost:5173"
        )),
    }
}

/// Every bound from `docs/architecture/runtime.md`; tests shrink them.
#[derive(Debug, Clone, Copy)]
pub struct Limits {
    pub store: StoreLimits,
    pub bounds: Bounds,
    pub http: HttpLimits,
    pub sse_buffer_events: usize,
    pub max_attribute_bytes: usize,
}

impl Default for Limits {
    fn default() -> Self {
        Self {
            store: StoreLimits {
                max_requests: MAX_STORED_REQUESTS,
                max_bytes: MAX_STORED_BYTES,
                max_spans_per_request: MAX_SPANS_PER_REQUEST,
                max_log_entries: MAX_LOG_ENTRIES,
                max_log_bytes: MAX_LOG_BYTES,
            },
            bounds: Bounds {
                graph: GraphLimits {
                    max_nodes: MAX_NODES,
                    max_edges: MAX_EDGES,
                },
                linker: LinkerLimits {
                    window_ms: LINK_WINDOW.as_millis() as u64,
                    max_pending: MAX_PENDING_CLIENTS,
                    max_orphans: MAX_ORPHAN_SERVERS,
                },
            },
            http: HttpLimits {
                max_body_bytes: MAX_OTLP_BODY_BYTES,
                body_read_timeout: BODY_READ_TIMEOUT,
                max_concurrent_ingest: MAX_CONCURRENT_INGEST,
                max_sse_clients: MAX_SSE_CLIENTS,
            },
            sse_buffer_events: SSE_BUFFER_EVENTS,
            max_attribute_bytes: MAX_ATTRIBUTE_VALUE_BYTES,
        }
    }
}

pub fn build(redact_keys: &[String], cors_origins: &[String], limits: Limits) -> Arc<AppState> {
    let keys: Vec<&str> = redact_keys.iter().map(String::as_str).collect();
    let shared = Arc::new(Shared::new(
        Box::new(MemoryStore::new(limits.store)),
        limits.bounds,
    ));
    let hub = Arc::new(SseHub::new(limits.sse_buffer_events));
    let ingest = Ingest::new(
        shared.clone(),
        Arc::new(ProtoCodec::new(limits.max_attribute_bytes)),
        hub.clone(),
        Redactor::new(&keys),
    );
    let query = Query::new(shared, hub);
    AppState::new(ingest, query, Clock::default(), limits.http, cors_origins)
}

#[cfg(test)]
mod tests {
    // Core
    use std::collections::HashMap;

    use super::*;

    fn config(vars: &[(&str, &str)]) -> Result<Config, String> {
        let vars: HashMap<String, String> = vars
            .iter()
            .map(|(k, v)| ((*k).into(), (*v).into()))
            .collect();
        Config::from_env(|name| vars.get(name).cloned())
    }

    #[test]
    fn defaults_are_loopback_and_add_no_keys() {
        let config = config(&[]).unwrap();
        assert_eq!(
            (config.otlp_addr, config.ui_addr),
            (DEFAULT_OTLP_ADDR, DEFAULT_UI_ADDR)
        );
        assert!(config.redact_keys.is_empty());
        assert_eq!(config.cors_origins, DEFAULT_CORS_ORIGINS);
    }

    #[test]
    fn variables_override_defaults() {
        let config = config(&[
            ("CHEPIO_LENS_OTLP_ADDR", "0.0.0.0:14318"),
            ("CHEPIO_LENS_REDACT_KEYS", " ssn, ,tenant_key "),
        ])
        .unwrap();
        assert_eq!(config.otlp_addr.to_string(), "0.0.0.0:14318");
        assert_eq!(config.redact_keys, ["ssn", "tenant_key"]);
    }

    #[test]
    fn cors_origins_are_normalized_as_browsers_send_them() {
        let listed = config(&[(
            "CHEPIO_LENS_CORS_ORIGINS",
            " HTTP://LocalHost:3000/ , ,https://app.test",
        )])
        .unwrap();
        assert_eq!(
            listed.cors_origins,
            ["http://localhost:3000", "https://app.test"]
        );
        let none = config(&[("CHEPIO_LENS_CORS_ORIGINS", "")]).unwrap();
        assert!(none.cors_origins.is_empty());
    }

    #[test]
    fn values_that_are_not_origins_are_refused() {
        for value in [
            "*",
            "http://*.test",
            "localhost:5173",
            "ftp://localhost",
            "http://localhost:5173/app",
            "http://",
            "http://user@localhost",
        ] {
            let error = config(&[("CHEPIO_LENS_CORS_ORIGINS", value)]).unwrap_err();
            assert!(
                error.starts_with("CHEPIO_LENS_CORS_ORIGINS:"),
                "{value}: {error}"
            );
        }
    }

    #[test]
    fn invalid_addresses_are_reported_by_name() {
        let error = config(&[("CHEPIO_LENS_UI_ADDR", "localhost")]).unwrap_err();
        assert!(
            error.starts_with("CHEPIO_LENS_UI_ADDR=\"localhost\""),
            "{error}"
        );
    }
}
