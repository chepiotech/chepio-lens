//! Attribute keys, legacy-to-stable name mapping and redaction rules shared by the collector and the Rust SDK.
//! No I/O and no OpenTelemetry SDK dependencies (`docs/architecture/components.md`).

pub mod grpc;
pub mod keys;
pub mod legacy;
pub mod node_metadata;
pub mod redaction;
