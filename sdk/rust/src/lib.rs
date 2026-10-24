//! One-call OpenTelemetry setup for axum + sqlx backends, reporting to the chepio-lens collector.

#[cfg(test)]
mod tests {
    #[test]
    fn package_name_matches_component_doc() {
        assert_eq!(env!("CARGO_PKG_NAME"), "chepio-lens-sdk");
    }
}
