//! Attribute keys, legacy-to-stable name mapping and redaction rules shared by the collector and the Rust SDK.
//! No I/O and no OpenTelemetry SDK dependencies (`docs/architecture/components.md`).

#[cfg(test)]
mod tests {
    #[test]
    fn package_name_matches_component_doc() {
        assert_eq!(env!("CARGO_PKG_NAME"), "chepio-lens-conventions");
    }
}
