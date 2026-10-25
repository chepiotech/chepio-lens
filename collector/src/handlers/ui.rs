// Core
use std::convert::Infallible;
use std::sync::Arc;
use std::sync::atomic::Ordering;

use axum::Json;
use axum::extract::{Path, Query, State};
use axum::http::StatusCode;
use axum::response::sse::{Event, KeepAlive, Sse};
use axum::response::{IntoResponse, Response};
use futures_util::StreamExt;
use serde::Deserialize;
// Domain
use crate::domain::log::{Layer, LogKind, LogQuery, StatusFilter};
use crate::domain::log_record::LogLevel;
use crate::domain::span::TraceId;
// Handlers
use super::AppState;
// Types
use crate::types::FeedItem;
use crate::types::api::{
    EdgeView, GraphView, LensEventName, LogEntryView, LogPageView, NodeView, RequestDetailView,
    StatsView, cursor_text, parse_cursor,
};
// Consts
use crate::consts::{LOG_PAGE_DEFAULT, LOG_PAGE_MAX};

pub(super) async fn graph(State(state): State<Arc<AppState>>) -> Json<GraphView> {
    let snapshot = state.query.graph(state.clock.now());
    Json(GraphView {
        nodes: snapshot.nodes.iter().map(NodeView::from).collect(),
        edges: snapshot.edges.iter().map(EdgeView::from).collect(),
        generated_at: snapshot.generated_at_ns.to_string(),
    })
}

/// SSE stream of `node`, `edge`, `request`, `log` and `resync` events; 503 once the client bound is reached.
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

/// Query string of `GET /api/logs` (`docs/architecture/interfaces.md`, UI API).
#[derive(Debug, Default, Deserialize)]
pub(super) struct LogParams {
    /// Comma-separated: `frontend`, `backend`, `database`.
    layer: Option<String>,
    node: Option<String>,
    edge: Option<String>,
    /// `ok` or `error`.
    status: Option<String>,
    level: Option<String>,
    kind: Option<String>,
    q: Option<String>,
    limit: Option<usize>,
    /// An entry id from an earlier page.
    before: Option<String>,
}

impl LogParams {
    fn query(self) -> Result<LogQuery, String> {
        let layers = self
            .layer
            .iter()
            .flat_map(|layers| layers.split(','))
            .map(str::trim)
            .filter(|layer| !layer.is_empty())
            .map(|layer| match layer {
                "frontend" => Ok(Layer::Frontend),
                "backend" => Ok(Layer::Backend),
                "database" => Ok(Layer::Database),
                other => Err(format!(
                    "unknown layer {other:?}; use frontend, backend or database"
                )),
            })
            .collect::<Result<_, _>>()?;
        let status = match self.status.as_deref() {
            None | Some("") => None,
            Some("ok") => Some(StatusFilter::Ok),
            Some("error") => Some(StatusFilter::Error),
            Some(other) => return Err(format!("unknown status {other:?}; use ok or error")),
        };
        let levels = self
            .level
            .iter()
            .flat_map(|value| value.split(','))
            .filter(|v| !v.is_empty())
            .map(|value| {
                LogLevel::parse(value.trim()).ok_or_else(|| "unknown log level".to_owned())
            })
            .collect::<Result<Vec<_>, _>>()?;
        let kinds = self
            .kind
            .iter()
            .flat_map(|value| value.split(','))
            .filter(|v| !v.is_empty())
            .map(|value| match value.trim() {
                "log" => Ok(LogKind::Log),
                "action" => Ok(LogKind::Action),
                "request" => Ok(LogKind::Request),
                "query" => Ok(LogKind::Query),
                "call" => Ok(LogKind::Call),
                "span" => Ok(LogKind::Span),
                _ => Err("unknown log kind".to_owned()),
            })
            .collect::<Result<Vec<_>, _>>()?;
        let before = match self.before.as_deref() {
            None | Some("") => None,
            Some(text) => Some(
                parse_cursor(text).ok_or_else(|| format!("before={text:?} is not an entry id"))?,
            ),
        };
        let some = |value: Option<String>| {
            value
                .map(|text| text.trim().to_owned())
                .filter(|text| !text.is_empty())
        };
        Ok(LogQuery {
            layers,
            node: some(self.node),
            edge: some(self.edge),
            status,
            levels,
            kinds,
            text: some(self.q),
            before,
            limit: self
                .limit
                .unwrap_or(LOG_PAGE_DEFAULT)
                .clamp(1, LOG_PAGE_MAX),
        })
    }
}

/// Log lines, newest first, filtered; `400` for unknown filter values.
pub(super) async fn logs(
    State(state): State<Arc<AppState>>,
    Query(params): Query<LogParams>,
) -> Response {
    let query = match params.query() {
        Ok(query) => query,
        Err(message) => return (StatusCode::BAD_REQUEST, message).into_response(),
    };
    let page = state.query.logs(&query);
    Json(LogPageView {
        entries: page.entries.iter().map(LogEntryView::from).collect(),
        next_before: page.next_before.map(cursor_text),
    })
    .into_response()
}

/// One request with all its spans; `404` once it has been evicted or reset.
pub(super) async fn request(
    State(state): State<Arc<AppState>>,
    Path(trace_id): Path<String>,
) -> Response {
    let Some(trace_id) = TraceId::from_hex(&trace_id) else {
        return (StatusCode::BAD_REQUEST, "a trace id is 32 hex digits").into_response();
    };
    match state.query.request(&trace_id) {
        Some(detail) => Json(RequestDetailView::from(&detail)).into_response(),
        None => (StatusCode::NOT_FOUND, "this request is no longer in memory").into_response(),
    }
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
