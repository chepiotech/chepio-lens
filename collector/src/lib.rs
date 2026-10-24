//! chepio-lens collector: receives OTLP spans, derives the live map and serves the UI. Layers and allowed imports:
//! `docs/architecture/components.md` (Collector internals).

pub mod adapters;
pub mod app;
pub mod consts;
pub mod domain;
pub mod handlers;
pub mod ports;
pub mod repositories;
pub mod services;
pub mod types;
