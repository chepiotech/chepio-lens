// Core
use std::sync::Arc;
use std::sync::atomic::Ordering;

use axum::body::Body;
use axum::extract::State;
use axum::http::header::{CONTENT_TYPE, RETRY_AFTER};
use axum::http::{HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use http_body_util::{BodyExt, LengthLimitError, Limited};
use tokio::time::timeout;
// Services
use crate::services::ingest::IngestReply;
// Handlers
use super::AppState;
// Types
use crate::types::OtlpEncoding;

/// OTLP/HTTP export: 200 (with partial success), 400 malformed, 408 slow body, 413 too large, 415 unsupported
/// content type, 503 + `Retry-After` when the concurrency bound is reached.
pub(super) async fn traces(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    body: Body,
) -> Response {
    let Some(encoding) = headers
        .get(CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .and_then(OtlpEncoding::from_content_type)
    else {
        return (
            StatusCode::UNSUPPORTED_MEDIA_TYPE,
            "use application/x-protobuf or application/json",
        )
            .into_response();
    };
    let Ok(_permit) = state.ingest_permits.clone().try_acquire_owned() else {
        state.batches_busy.fetch_add(1, Ordering::Relaxed);
        return (StatusCode::SERVICE_UNAVAILABLE, [(RETRY_AFTER, "1")]).into_response();
    };
    let limited = Limited::new(body, state.limits.max_body_bytes);
    let bytes = match timeout(state.limits.body_read_timeout, limited.collect()).await {
        Err(_) => return StatusCode::REQUEST_TIMEOUT.into_response(),
        Ok(Err(error)) if error.downcast_ref::<LengthLimitError>().is_some() => {
            return StatusCode::PAYLOAD_TOO_LARGE.into_response();
        }
        Ok(Err(_)) => return StatusCode::BAD_REQUEST.into_response(),
        Ok(Ok(collected)) => collected.to_bytes(),
    };
    match state.ingest.handle(encoding, &bytes, state.clock.now()) {
        IngestReply::Accepted { body } => {
            ([(CONTENT_TYPE, encoding.content_type())], body).into_response()
        }
        IngestReply::Malformed { message } => {
            if state.warnings.should_log("malformed_otlp") {
                tracing::warn!(%message, "rejected a malformed OTLP export (logged at most once per minute)");
            }
            (StatusCode::BAD_REQUEST, message).into_response()
        }
    }
}
