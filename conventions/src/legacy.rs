//! Legacy semantic convention names mapped to stable ones. The collector applies this once, at ingest (I8).

// Consts
use crate::keys::{
    DB_NAMESPACE, DB_QUERY_TEXT, DB_SYSTEM_NAME, HTTP_REQUEST_METHOD, HTTP_RESPONSE_STATUS_CODE,
    RPC_SYSTEM_NAME, SERVER_ADDRESS, SERVER_PORT, URL_FULL,
};

/// Legacy attribute renamed to a stable one with the same value.
pub const RENAMES: &[(&str, &str)] = &[
    ("http.method", HTTP_REQUEST_METHOD),
    ("http.url", URL_FULL),
    ("http.status_code", HTTP_RESPONSE_STATUS_CODE),
    ("net.peer.name", SERVER_ADDRESS),
    ("net.peer.port", SERVER_PORT),
    ("db.system", DB_SYSTEM_NAME),
    ("db.name", DB_NAMESPACE),
    ("db.statement", DB_QUERY_TEXT),
    ("rpc.system", RPC_SYSTEM_NAME),
];

pub const RPC_GRPC_STATUS_CODE: &str = "rpc.grpc.status_code";
pub const RPC_SERVICE: &str = "rpc.service";

/// Legacy `http.target` (`/path?query`), which maps to `url.path` and `url.query`.
pub const HTTP_TARGET: &str = "http.target";

/// The stable name for `key`, or `None` when `key` is not a renamed legacy attribute.
pub fn stable_name(key: &str) -> Option<&'static str> {
    RENAMES
        .iter()
        .find(|(legacy, _)| *legacy == key)
        .map(|(_, stable)| *stable)
}

/// Splits a legacy `http.target` into path and query (without `?`).
pub fn split_target(target: &str) -> (&str, Option<&str>) {
    match target.split_once('?') {
        Some((path, query)) => (path, Some(query)),
        None => (target, None),
    }
}

#[cfg(test)]
mod tests {
    // Core
    use super::*;

    #[test]
    fn renames_legacy_names_and_leaves_others() {
        assert_eq!(stable_name("http.method"), Some("http.request.method"));
        assert_eq!(stable_name("db.statement"), Some("db.query.text"));
        assert_eq!(stable_name("http.request.method"), None);
        assert_eq!(stable_name("custom.attr"), None);
    }

    #[test]
    fn splits_http_target() {
        assert_eq!(split_target("/notes?limit=5"), ("/notes", Some("limit=5")));
        assert_eq!(split_target("/notes"), ("/notes", None));
        assert_eq!(split_target("/notes?"), ("/notes", Some("")));
    }
}
