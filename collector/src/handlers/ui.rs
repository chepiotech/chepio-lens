// Core
use std::convert::Infallible;
use std::sync::Arc;
use std::sync::atomic::Ordering;

use axum::Json;
use axum::extract::State;
use axum::http::StatusCode;
use axum::response::sse::{Event, KeepAlive, Sse};
use axum::response::{IntoResponse, Response};
use futures_util::StreamExt;
// Handlers
use super::AppState;
// Types
use crate::types::FeedItem;
use crate::types::api::{EdgeView, GraphView, LensEventName, NodeView, StatsView};

pub(super) async fn graph(State(state): State<Arc<AppState>>) -> Json<GraphView> {
    let snapshot = state.query.graph(state.clock.now());
    Json(GraphView {
        nodes: snapshot.nodes.iter().map(NodeView::from).collect(),
        edges: snapshot.edges.iter().map(EdgeView::from).collect(),
        generated_at: snapshot.generated_at_ns.to_string(),
    })
}

/// SSE stream of `node`, `edge`, `request` and `resync` events; 503 once the client bound is reached.
pub(super) async fn events(State(state): State<Arc<AppState>>) -> Response {
    let Ok(permit) = state.sse_permits.clone().try_acquire_owned() else {
        return (StatusCode::SERVICE_UNAVAILABLE, "too many event streams").into_response();
    };
    let stream = state.query.subscribe().map(move |item| {
        // The permit lives as long as the stream, so a closed tab frees its slot.
        let _slot = &permit;
        Ok::<_, Infallible>(match item {
            FeedItem::Event(event) => Event::default().event(event.name).data(event.data.as_str()),
            FeedItem::Resync => Event::default()
                .event(LensEventName::Resync.as_str())
                .data("{}"),
        })
    });
    Sse::new(stream)
        .keep_alive(KeepAlive::default())
        .into_response()
}

pub(super) async fn reset(State(state): State<Arc<AppState>>) -> StatusCode {
    state.ingest.reset();
    StatusCode::NO_CONTENT
}

pub(super) async fn stats(State(state): State<Arc<AppState>>) -> Json<StatsView> {
    Json(StatsView {
        batches_busy: state.batches_busy.load(Ordering::Relaxed),
        sse_clients: state.limits.max_sse_clients - state.sse_permits.available_permits(),
        ..state.query.stats()
    })
}

pub(super) async fn healthz() -> &'static str {
    "ok"
}
