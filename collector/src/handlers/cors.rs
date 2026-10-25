//! CORS on the ingest listener (`docs/architecture/security.md`): browsers may post spans only from the origins in
//! `CHEPIO_LENS_CORS_ORIGINS`. Requests without `Origin` (backend SDKs, curl) are not affected.

// Core
use std::sync::Arc;

use axum::extract::{Request, State};
use axum::http::header::{CONTENT_TYPE, ORIGIN, RETRY_AFTER};
use axum::http::{HeaderValue, Method, StatusCode};
use axum::middleware::Next;
use axum::response::{IntoResponse, Response};
use tower_http::cors::{AllowOrigin, CorsLayer};
// Handlers
use super::AppState;
// Consts
use crate::consts::CORS_MAX_AGE;

/// Answers preflights and adds `Access-Control-Allow-Origin` for the allowed origins. `Retry-After` is exposed so the
/// browser exporter can honor a `503`.
pub(super) fn layer(origins: &[HeaderValue]) -> CorsLayer {
    CorsLayer::new()
        .allow_origin(AllowOrigin::list(origins.iter().cloned()))
        .allow_methods([Method::POST])
        .allow_headers([CONTENT_TYPE])
        .expose_headers([RETRY_AFTER])
        .max_age(CORS_MAX_AGE)
}

/// Any request, preflight or not, from an origin outside the list gets `403` before it reaches CORS or ingest, and a
/// warning at most once per minute, so a misconfigured app is visible in the collector log.
pub(super) async fn reject_unknown_origins(
    State(state): State<Arc<AppState>>,
    request: Request,
    next: Next,
) -> Response {
    match request.headers().get(ORIGIN) {
        Some(origin) if !state.cors_origins.contains(origin) => {
            if state.warnings.should_log("cors_origin") {
                tracing::warn!(
                    ?origin,
                    "rejected spans from a browser origin not in CHEPIO_LENS_CORS_ORIGINS (logged at most once per minute)"
                );
            }
            StatusCode::FORBIDDEN.into_response()
        }
        _ => next.run(request).await,
    }
}
