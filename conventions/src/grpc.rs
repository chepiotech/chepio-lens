//! Native gRPC protocol values shared by instrumentation and normalized span consumers.

/// Protocol status names, indexed by the wire code; unknown values are not reflected as arbitrary labels.
pub const STATUS_NAMES: [&str; 17] = [
    "OK",
    "CANCELLED",
    "UNKNOWN",
    "INVALID_ARGUMENT",
    "DEADLINE_EXCEEDED",
    "NOT_FOUND",
    "ALREADY_EXISTS",
    "PERMISSION_DENIED",
    "RESOURCE_EXHAUSTED",
    "FAILED_PRECONDITION",
    "ABORTED",
    "OUT_OF_RANGE",
    "UNIMPLEMENTED",
    "INTERNAL",
    "UNAVAILABLE",
    "DATA_LOSS",
    "UNAUTHENTICATED",
];

pub fn status_name(code: u16) -> Option<&'static str> {
    STATUS_NAMES.get(usize::from(code)).copied()
}

pub fn is_error(status: &str, client: bool) -> bool {
    if client {
        status != "OK"
    } else {
        matches!(
            status,
            "UNKNOWN"
                | "DEADLINE_EXCEEDED"
                | "UNIMPLEMENTED"
                | "INTERNAL"
                | "UNAVAILABLE"
                | "DATA_LOSS"
        )
    }
}

/// The bounded qualified method from a native gRPC path; no query, percent escapes or arbitrary text.
pub fn method(path: &str) -> Option<&str> {
    let method = path.strip_prefix('/').unwrap_or(path);
    if method.len() > 512 {
        return None;
    }
    let (service, name) = method.split_once('/')?;
    let identifier = |part: &str| {
        let mut bytes = part.bytes();
        bytes
            .next()
            .is_some_and(|b| b.is_ascii_alphabetic() || b == b'_')
            && bytes.all(|b| b.is_ascii_alphanumeric() || b == b'_')
    };
    (service.split('.').all(identifier) && identifier(name)).then_some(method)
}

#[cfg(test)]
mod tests {
    // Core
    use super::*;

    #[test]
    fn wire_codes_and_bounded_methods() {
        assert_eq!(status_name(0), Some("OK"));
        assert_eq!(status_name(16), Some("UNAUTHENTICATED"));
        assert_eq!(status_name(17), None);
        assert_eq!(
            method("/school.Identity/GetUser"),
            Some("school.Identity/GetUser")
        );
        for path in ["/", "/x/y/z", "/x/y?token=secret", "/x..y/Z", "/x/1bad"] {
            assert_eq!(method(path), None);
        }
        assert_eq!(method(&format!("/{}/Call", "a".repeat(512))), None);
        assert!(is_error("INVALID_ARGUMENT", true));
        assert!(!is_error("INVALID_ARGUMENT", false));
        assert!(is_error("INTERNAL", false));
    }
}
