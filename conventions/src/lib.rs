//! Attribute keys, legacy-to-stable name mapping and redaction rules shared by the collector and the Rust SDK.
//! No I/O and no OpenTelemetry SDK dependencies (`docs/architecture/components.md`).

pub mod keys;
pub mod legacy;
pub mod redaction;
