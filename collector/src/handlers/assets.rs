//! The UI built by `pnpm --filter ui build`: embedded in release builds, read from `ui/dist` on disk in debug builds.

// Core
use axum::http::header::{
    CACHE_CONTROL, CONTENT_SECURITY_POLICY, CONTENT_TYPE, X_CONTENT_TYPE_OPTIONS,
};
use axum::http::{HeaderValue, StatusCode, Uri};
use axum::response::{IntoResponse, Response};
use rust_embed::RustEmbed;

#[derive(RustEmbed)]
#[folder = "../ui/dist"]
#[allow_missing = true]
struct UiAssets;

/// `docs/architecture/security.md`: payloads render as text, scripts and connections stay on this origin.
const CONTENT_SECURITY: &str = "default-src 'self'; connect-src 'self'";
const NOT_BUILT: &str = "The chepio-lens UI is not built into this binary. In a clone of chepio-lens run \
`pnpm --filter ui build`, then build the collector again or `cargo install --path collector --locked`.";

pub(super) async fn asset(uri: Uri) -> Response {
    let path = match uri.path().trim_start_matches('/') {
        "" => "index.html",
        path => path,
    };
    match UiAssets::get(path) {
        Some(file) => {
            // Vite fingerprints everything under assets/, so those files never change.
            let cache = match path.starts_with("assets/") {
                true => "public, max-age=31536000, immutable",
                false => "no-cache",
            };
            (
                [(CONTENT_TYPE, content_type(path)), (CACHE_CONTROL, cache)],
                file.data,
            )
                .into_response()
        }
        None if path == "index.html" => (StatusCode::NOT_FOUND, NOT_BUILT).into_response(),
        None => StatusCode::NOT_FOUND.into_response(),
    }
}

pub(super) async fn security_headers(mut response: Response) -> Response {
    let headers = response.headers_mut();
    headers.insert(
        CONTENT_SECURITY_POLICY,
        HeaderValue::from_static(CONTENT_SECURITY),
    );
    headers.insert(X_CONTENT_TYPE_OPTIONS, HeaderValue::from_static("nosniff"));
    response
}

fn content_type(path: &str) -> &'static str {
    match path.rsplit_once('.').map(|(_, extension)| extension) {
        Some("html") => "text/html; charset=utf-8",
        Some("js") => "text/javascript; charset=utf-8",
        Some("css") => "text/css; charset=utf-8",
        Some("svg") => "image/svg+xml",
        Some("png") => "image/png",
        Some("ico") => "image/x-icon",
        Some("json") => "application/json",
        Some("woff2") => "font/woff2",
        _ => "application/octet-stream",
    }
}

#[cfg(test)]
mod tests {
    // Core
    use super::*;

    #[test]
    fn content_types_follow_the_extension() {
        assert_eq!(content_type("index.html"), "text/html; charset=utf-8");
        assert_eq!(
            content_type("assets/index-abc.js"),
            "text/javascript; charset=utf-8"
        );
        assert_eq!(
            content_type("images/chepio-tech/logo_designed.svg"),
            "image/svg+xml"
        );
        assert_eq!(content_type("unknown"), "application/octet-stream");
    }
}
